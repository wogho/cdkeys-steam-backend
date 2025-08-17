// server.js - CDKeys-Steam Price Comparison Backend
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const NodeCache = require('node-cache');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// 캐시 설정 (TTL: 1시간)
const cache = new NodeCache({ stdTTL: 3600 });

// 미들웨어 설정
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            scriptSrcAttr: ["'unsafe-inline'"],  // 이 줄 추가!
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },
    crossOriginOpenerPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 100 // 최대 100개 요청
});
app.use('/api/', limiter);

// Puppeteer 브라우저 인스턴스 (재사용)
let browser = null;

// 브라우저 초기화
async function initBrowser() {
    if (!browser) {
        console.log('Puppeteer 브라우저 초기화...');
        
        // Chromium 경로 확인
        const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
        
        browser = await puppeteer.launch({
            headless: 'new', // 새로운 Headless 모드 사용
            executablePath: chromiumPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // ARM64에서 안정성 향상
                '--disable-gpu',
                '--disable-features=VizDisplayCompositor'
            ],
            timeout: 60000 // 타임아웃 증가
        });
    }
    return browser;
}

// CDKeys 게임 목록 크롤링
async function fetchCDKeysGames(url) {
    const cacheKey = `cdkeys_${url}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log('CDKeys 캐시 데이터 사용');
        return cached;
    }

    try {
        const browser = await initBrowser();
        const page = await browser.newPage();
        
        // User-Agent 설정
        await page.setUserAgent('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`CDKeys 페이지 로딩: ${url}`);
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // 페이지 로드 대기
        await page.waitForSelector('.product-item', { timeout: 10000 });
        
        // 게임 목록 추출
        const games = await page.evaluate(() => {
            const gameList = [];
            const items = document.querySelectorAll('.product-item');
            
            items.forEach(item => {
                const linkElement = item.querySelector('.product-item-link');
                const priceElement = item.querySelector('.price');
                
                if (linkElement && priceElement) {
                    let name = linkElement.textContent.trim();
                    // 플랫폼 관련 텍스트 제거
                    name = name.replace(/\s*(PC|PS4|PS5|Xbox|DLC|Digital|Download|Steam|Key|Global|EU|US|UK).*$/gi, '').trim();
                    
                    const price = priceElement.textContent.trim();
                    const url = linkElement.href;
                    
                    gameList.push({ name, price, url });
                }
            });
            
            return gameList;
        });
        
        await page.close();
        
        console.log(`CDKeys에서 ${games.length}개 게임 발견`);
        cache.set(cacheKey, games);
        return games;
        
    } catch (error) {
        console.error('CDKeys 크롤링 오류:', error);
        throw error;
    }
}

// Steam 가격 검색
async function fetchSteamPrice(gameName) {
    const cacheKey = `steam_${gameName}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Steam 캐시 데이터 사용: ${gameName}`);
        return cached;
    }

    try {
        const browser = await initBrowser();
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Steam 검색
        const searchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(gameName)}`;
        console.log(`Steam 검색: ${gameName}`);
        
        await page.goto(searchUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // 첫 번째 검색 결과 클릭
        const firstResult = await page.$('#search_resultsRows a');
        if (!firstResult) {
            console.log(`Steam에서 게임을 찾을 수 없음: ${gameName}`);
            return null;
        }
        
        // 게임 페이지로 이동
        const gameUrl = await page.evaluate(el => el.href, firstResult);
        await page.goto(gameUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // 연령 확인 처리
        const ageCheck = await page.$('#ageYear');
        if (ageCheck) {
            await page.select('#ageYear', '1990');
            await page.click('#view_product_page_btn');
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
        
        // 가격 정보 추출
        const priceInfo = await page.evaluate(() => {
            const result = {};
            
            // 할인 가격이 있는 경우
            const discountOriginal = document.querySelector('.discount_original_price');
            const discountFinal = document.querySelector('.discount_final_price');
            
            if (discountOriginal && discountFinal) {
                result.original = discountOriginal.textContent.trim();
                result.final = discountFinal.textContent.trim();
                
                const discountPct = document.querySelector('.discount_pct');
                if (discountPct) {
                    result.discount = discountPct.textContent.trim();
                }
            } else {
                // 일반 가격
                const priceElement = document.querySelector('.game_purchase_price.price, .game_area_purchase_game .price');
                if (priceElement) {
                    result.final = priceElement.textContent.trim();
                    result.original = result.final;
                }
            }
            
            // 게임 이름도 가져오기
            const nameElement = document.querySelector('.apphub_AppName');
            if (nameElement) {
                result.exactName = nameElement.textContent.trim();
            }
            
            return result;
        });
        
        await page.close();
        
        if (priceInfo && (priceInfo.original || priceInfo.final)) {
            console.log(`Steam 가격 발견: ${gameName} - ${priceInfo.final}`);
            cache.set(cacheKey, priceInfo);
            return priceInfo;
        }
        
        return null;
        
    } catch (error) {
        console.error(`Steam 가격 검색 오류 (${gameName}):`, error);
        return null;
    }
}

// 가격 파싱 (원화/달러 처리)
function parsePrice(priceString) {
    if (!priceString) return 0;
    
    // 원화 처리
    if (priceString.includes('₩')) {
        return parseInt(priceString.replace(/[₩,\s]/g, ''));
    }
    
    // 달러 처리 (환율 적용)
    if (priceString.includes('$')) {
        const dollars = parseFloat(priceString.replace(/[$,\s]/g, ''));
        return Math.round(dollars * 1320); // 환율은 실제 API로 대체 가능
    }
    
    // 유로 처리
    if (priceString.includes('€')) {
        const euros = parseFloat(priceString.replace(/[€,\s]/g, ''));
        return Math.round(euros * 1430);
    }
    
    // 파운드 처리
    if (priceString.includes('£')) {
        const pounds = parseFloat(priceString.replace(/[£,\s]/g, ''));
        return Math.round(pounds * 1670);
    }
    
    return 0;
}

// API 엔드포인트: 가격 비교
app.post('/api/compare', async (req, res) => {
    const { url, minDifference = 5000 } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'CDKeys URL이 필요합니다.' });
    }
    
    try {
        console.log('=== 가격 비교 시작 ===');
        console.log(`URL: ${url}`);
        console.log(`최소 차액: ${minDifference}원`);
        
        // CDKeys 게임 목록 가져오기
        const cdkeysGames = await fetchCDKeysGames(url);
        
        if (cdkeysGames.length === 0) {
            return res.json({ 
                success: true, 
                games: [],
                message: '게임을 찾을 수 없습니다.' 
            });
        }
        
        // Steam 가격과 비교
        const comparisons = [];
        
        for (const game of cdkeysGames) {
            try {
                const steamPrice = await fetchSteamPrice(game.name);
                
                if (steamPrice) {
                    const cdkeysPrice = parsePrice(game.price);
                    const steamOriginalPrice = parsePrice(steamPrice.original || steamPrice.final);
                    const steamFinalPrice = parsePrice(steamPrice.final);
                    const savings = steamOriginalPrice - cdkeysPrice;
                    
                    console.log(`${game.name}: CDKeys ${cdkeysPrice}원 vs Steam ${steamOriginalPrice}원 (절약: ${savings}원)`);
                    
                    if (savings >= minDifference) {
                        comparisons.push({
                            name: game.name,
                            exactName: steamPrice.exactName || game.name,
                            cdkeysPrice,
                            cdkeysUrl: game.url,
                            steamOriginalPrice,
                            steamFinalPrice,
                            steamDiscount: steamPrice.discount,
                            savings,
                            savingsPercent: Math.round((savings / steamOriginalPrice) * 100)
                        });
                    }
                }
                
                // 요청 간 딜레이 (Steam 차단 방지)
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`게임 비교 오류 (${game.name}):`, error.message);
            }
        }
        
        // 절약액 기준 정렬
        comparisons.sort((a, b) => b.savings - a.savings);
        
        console.log(`=== 비교 완료: ${comparisons.length}개 할인 게임 발견 ===`);
        
        res.json({
            success: true,
            totalGames: cdkeysGames.length,
            discountedGames: comparisons.length,
            games: comparisons
        });
        
    } catch (error) {
        console.error('비교 처리 오류:', error);
        res.status(500).json({ 
            error: '가격 비교 중 오류가 발생했습니다.',
            details: error.message 
        });
    }
});

// API 엔드포인트: 캐시 삭제
app.delete('/api/cache', (req, res) => {
    cache.flushAll();
    console.log('캐시 초기화 완료');
    res.json({ success: true, message: '캐시가 초기화되었습니다.' });
});

// API 엔드포인트: 서버 상태
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        cache: {
            keys: cache.keys().length,
            stats: cache.getStats()
        },
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// 헬스 체크
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 정적 파일 제공 (프론트엔드)
app.use(express.static('public'));

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ========================================
    CDKeys-Steam 가격 비교 서버
    포트: ${PORT}
    URL: http://0.0.0.0:${PORT}
    외부 접속: http://140.238.30.184:${PORT}
    ========================================
    `);
    
    // 브라우저 사전 초기화
    initBrowser().then(() => {
        console.log('Puppeteer 브라우저 준비 완료');
    }).catch(err => {
        console.error('브라우저 초기화 실패:', err);
    });
});

// 종료 처리
process.on('SIGINT', async () => {
    console.log('\n서버 종료 중...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});