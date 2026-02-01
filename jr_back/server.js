// server.js (FINAL CODE WITH SAFETY SCAN AND CLEANING PROXY)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio'); // Library to parse and manipulate HTML
const app = express();
const PORT = 3000;

// Configuration: Allow frontend to connect (Handles CORS errors from file:// and localhost)
app.use(cors({ origin: ['http://localhost', 'null', 'http://127.0.0.1:5500'] })); 
app.use(express.json());

// 🚨 IMPORTANT: Replace with your actual TMDb API Key
const TMDB_API_KEY = "038650abc5be23d9cb8e9f4803b5e2c9"; 

// --- Configuration for Safety Scoring (Your Algorithm) ---
const SECURITY_CONFIG = {
    RED_FLAGS: ['violence', 'blood', 'death', 'kill', 'murder', 'gun', 'drugs', 'sex', 'profanity', 'nudity', 'war', 'crime', 'terror'],
    RISKY_GENRES: ['Horror', 'Crime', 'Thriller', 'Mystery', 'War', 'History'],
    PENALTIES: {
        R_RATING: 80, 
        PG13_RATING: 50,
        PG_RATING: 20,
        RISKY_GENRE: 15,
        KEYWORD_HIT: 10
    },
    MAX_RISK_SCORE: 100 
};

// --- Comprehensive Safety Scoring Function ---
function runComprehensiveScan(movie) {
    let riskScore = 0;
    let advisoryNotes = [];
    const overviewText = (movie.overview || '').toLowerCase();
    const movieGenres = movie.genres.map(g => g.name);

    // 1. Certification Check 
    const usRelease = movie.releases?.countries.find(c => c.iso_3166_1 === 'US');
    const certification = usRelease?.certification || 'NR';

    switch (certification) {
        case 'R':
            riskScore += SECURITY_CONFIG.PENALTIES.R_RATING;
            advisoryNotes.push(`Certification: A (Not suitable for children).`);
            break;
        case 'PG-13':
            riskScore += SECURITY_CONFIG.PENALTIES.PG13_RATING;
            advisoryNotes.push(`Certification: U/A-13 (High parental guidance needed).`);
            break;
        case 'PG':
            riskScore += SECURITY_CONFIG.PENALTIES.PG_RATING;
            advisoryNotes.push(`Certification: U/A (Some material may be unsuitable for children).`);
            break;
    }

    // 2. Risky Genre Check
    const riskyGenresFound = movieGenres.filter(genre => SECURITY_CONFIG.RISKY_GENRES.includes(genre));
    if (riskyGenresFound.length > 0) {
        riskScore += Math.min(SECURITY_CONFIG.PENALTIES.PG13_RATING, SECURITY_CONFIG.PENALTIES.RISKY_GENRE * riskyGenresFound.length); 
        advisoryNotes.push(`Genres flagged: ${riskyGenresFound.join(', ')}.`);
    }

    // 3. Keyword Density Scan
    let flaggedKeywords = [];
    SECURITY_CONFIG.RED_FLAGS.forEach(flag => {
        const regex = new RegExp(flag, 'gi');
        const matches = overviewText.match(regex);
        if (matches) {
            riskScore += SECURITY_CONFIG.PENALTIES.KEYWORD_HIT * matches.length;
            flaggedKeywords.push(`${flag} (${matches.length} times)`);
        }
    });
    if (flaggedKeywords.length > 0) {
        advisoryNotes.push(`Synopsis flags: ${flaggedKeywords.join(', ')}.`);
    }
    
    // 4. Final Safety Score Calculation (Normalized 0 to 100)
    const safetyScore = Math.max(0, 100 - riskScore);

    let finalSummary = '';
    let recommendation = '';
    if (safetyScore <= 20) {
        finalSummary = "🚨 DANGER: Highly unsuitable for children. Rated for adult themes/content.";
        recommendation = "Do not show this content without deep parental review.";
    } else if (safetyScore <= 80) {
        finalSummary = "⚠️ CAUTION: Significant risk detected. Parental guidance is strongly advised.";
        recommendation = "Proceed with caution. Content may be distressing.";
    } else {
        finalSummary = "✅ Appears safe for kids based on content analysis.";
        recommendation = "Highly recommended for all ages.";
    }

    return {
        normalizedScore: safetyScore,
        summary: finalSummary,
        recommendation: recommendation,
        advisoryNotes: advisoryNotes.length > 0 ? advisoryNotes : ["No specific safety flags found in official data."]
    };
}

// -----------------------------------------------------------
// --- STREAMING PROXY ENDPOINT: Fetches Vidsrc and Cleans ---
// -----------------------------------------------------------
app.get('/api/clean-stream/:movieId', async (req, res) => {
    const movieId = req.params.movieId;
    
    // Use the most stable Vidsrc URL format
    const vidsrcUrl = `https://vidsrc.to/embed/movie/${movieId}`; 

    try {
        console.log(`[STREAM PROXY] Fetching Vidsrc content for TMDb ID: ${movieId} from: ${vidsrcUrl}`);
        
        const vidsrcResponse = await axios.get(vidsrcUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            validateStatus: (status) => status < 500,
        });
        
        const html = vidsrcResponse.data;
        const $ = cheerio.load(html);

        // --- AD STRIPPING LOGIC (CRITICAL FOR SAFETY) ---
        // 1. Remove all script tags that often load external ads/trackers
        $('script').remove();
        
        // 2. Remove common ad/pop-up related elements by ID or class.
        // NOTE: These selectors may change and need updating over time!
        $('div[id*="ad"], div[class*="ad"], div[class*="popup"], .floating-ad').remove();
        
        // 3. Remove all event listeners that trigger pop-unders/pop-ups
        $('*').removeAttr('onclick').removeAttr('onmouseover');
        
        // 4. Find the core video player (often an iframe or video tag)
        const videoElement = $('iframe[allowfullscreen], video');
        
        if (videoElement.length === 0) {
            // If the video element wasn't found, the stream is likely broken.
            return res.status(404).send('<h1>Error</h1><p>Stream source is unstable or content not indexed.</p>');
        }
        
        // 5. Return the content of the body, which should now only contain the player
        res.type('html').send($.html());

    } catch (error) {
        console.error("[STREAM PROXY] Failed to fetch or clean Vidsrc page:", error.message);
        res.status(500).send('<h1>Error Loading Clean Stream</h1><p>The streaming source is unstable or the network failed on the server side.</p>');
    }
});

// ----------------------------------------------------------
// --- SAFETY CHECK ENDPOINT: Fetches TMDb data and Scans ---
// ----------------------------------------------------------
app.get('/api/safety-check/:movieId', async (req, res) => {
    const movieId = req.params.movieId;

    const tmdbUrl = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}&language=en-US&append_to_response=releases,genres`;

    try {
        const tmdbResponse = await axios.get(tmdbUrl, {
            timeout: 5000, 
            validateStatus: (status) => status < 500,
        });

        if (tmdbResponse.status !== 200) {
            const statusMessage = tmdbResponse.data?.status_message || 'Unknown TMDb Error.';
            return res.status(500).json({
                error: 'TMDb Data Fetch Failed.',
                details: `TMDb responded with status ${tmdbResponse.status}. Message: ${statusMessage}`
            });
        }

        const movie = tmdbResponse.data;
        const scanReport = runComprehensiveScan(movie);

        return res.json({
            movieTitle: movie.title,
            ...scanReport
        });

    } catch (error) {
        console.error("Safety check failed (Node.js Network Error):", error.message);
        return res.status(500).json({ error: 'Node.js experienced a network issue (DNS/Firewall) connecting to TMDb.', details: error.message });
    }
});


// --- Server Listener ---
app.listen(PORT, () => {
    console.log(`Safety Scan and Proxy API running on http://localhost:${PORT}`);
});