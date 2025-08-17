// server.js - CDKeys-Steam Price Comparison Backend (Enhanced Multi-Stage Search)
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const NodeCache = require('node-cache');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Steam API 설정
const STEAM_STORE_API_BASE = 'https://store.steampowered.com/api';

// 캐시 설정 (TTL: 1시간)
const cache = new NodeCache({ stdTTL: 3600 });

// Express 프록시 설정 (Rate Limit 오류 해결)
app.set('trust proxy', true);

// 미들웨어 설정
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            scriptSrcAttr: ["'unsafe-inline'"],
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

// 게임명 정리 함수 (PC, DLC 제거 로직 개선)
function cleanGameName(originalName) {
    let cleanName = originalName.trim();
    
    // wogho님 요청: PC, DLC 등 플랫폼/확장팩 키워드 제거
    const platformPatterns = [
        // PC-DLC 관련 (우선 처리)
        /\s+PC-DLC\s*$/i,                       // 끝에 PC-DLC ✅
        /\s+\(PC-DLC\)\s*$/i,                   // (PC-DLC)
        /\s+-\s*PC-DLC\s*$/i,                   // - PC-DLC
        /\s+PC - DLC\s*$/i,
        /\s+\(PC\/Mac\)\s*$/i,                  // (PC/Mac)
        /\s+-\s*PC\/Mac\s*$/i,                  // - PC/Mac
        /\s+\[PC\/Mac\]\s*$/i,                  // [PC/Mac]
        /\s+PC\/Mac\s*-\s*$/i,                  // 끝에 PC/Mac -
        /\s+PC\/Mac\s*-?\s*$/i,                 // PC/Mac - 또는 PC/Mac
        /\s+PC\/Mac\s+\-\s*$/i,                 // PC/Mac -
        /\s+\(PC\/Mac\)\s*-?\s*$/i,             // (PC/Mac) - 또는 (PC/Mac)
                
        // PC 관련
        /\s+PC\s*$/i,                           // 끝에 PC
        /\s+\(PC\)\s*$/i,                       // (PC)
        /\s+-\s*PC\s*$/i,                       // - PC
        
        // DLC 관련
        /\s+DLC\s*$/i,                          // 끝에 DLC
        /\s+\(DLC\)\s*$/i,                      // (DLC)
        /\s+-\s*DLC\s*$/i,                      // - DLC
        
        // Steam 관련
        /\s+Steam\s*$/i,                        // 끝에 Steam
        /\s+\(Steam\)\s*$/i,                    // (Steam)
        /\s+-\s*Steam\s*$/i,                    // - Steam
        /\s+Steam\s+Key\s*$/i,                  // Steam Key
        /\s+Steam\s+Code\s*$/i,                 // Steam Code
        
        // Key/Code 관련
        /\s+Key\s*$/i,                          // 끝에 Key
        /\s+Code\s*$/i,                         // 끝에 Code
        /\s+\(Key\)\s*$/i,                      // (Key)
        /\s+\(Code\)\s*$/i,                     // (Code)
        
        // Digital 관련
        /\s+Digital\s*$/i,                      // 끝에 Digital
        /\s+\(Digital\)\s*$/i,                  // (Digital)
        /\s+Digital\s+Download\s*$/i,           // Digital Download
        /\s+Download\s*$/i,                     // 끝에 Download
        
        // 지역 관련
        /\s+Global\s*$/i,                       // 끝에 Global
        /\s+\[Global\]\s*$/i,                   // [Global]
        /\s+\(Global\)\s*$/i,                   // (Global)
        /\s+Worldwide\s*$/i,                    // 끝에 Worldwide
        /\s+\[Worldwide\]\s*$/i,                // [Worldwide]
        /\s+EU\s*$/i,                           // 끝에 EU
        /\s+US\s*$/i,                           // 끝에 US
        /\s+UK\s*$/i,                           // 끝에 UK
        /\s+ROW\s*$/i,                          // 끝에 ROW (Rest of World)
        
        // 기타 불필요한 키워드
        /\s+Edition\s*$/i,                      // 끝에 Edition (단독으로만)
        /\s+Game\s*$/i,                         // 끝에 Game
        /\s+\(Game\)\s*$/i                      // (Game)
    ];
    
    // 각 패턴을 순차적으로 적용
    platformPatterns.forEach(pattern => {
        const beforeClean = cleanName;
        cleanName = cleanName.replace(pattern, '').trim();
        
        if (beforeClean !== cleanName) {
            console.log(`🔧 패턴 적용: "${beforeClean}" → "${cleanName}"`);
        }
    });
    
    // 안전성 검증
    const originalLength = originalName.length;
    const cleanLength = cleanName.length;
    const retentionRatio = cleanLength / originalLength;
    
    // 게임명이 너무 짧아졌거나 30% 이하로 줄어들면 원본 사용
    if (cleanLength < 3 || retentionRatio < 0.3) {
        console.warn(`⚠️ 과도한 정리 감지: "${originalName}" → "${cleanName}" (${(retentionRatio * 100).toFixed(1)}%), 원본 사용`);
        return originalName;
    }
    
    // 최종 정리 결과 로그
    if (cleanName !== originalName) {
        console.log(`✅ 게임명 정리 완료: "${originalName}" → "${cleanName}"`);
    }
    
    return cleanName;
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
        
        await page.setUserAgent('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`CDKeys 페이지 로딩: ${url}`);
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        await page.waitForSelector('.product-item', { timeout: 10000 });
        
        const games = await page.evaluate(() => {
            const gameList = [];
            const items = document.querySelectorAll('.product-item');
            
            items.forEach((item, index) => {
                const linkElement = item.querySelector('.product-item-link');
                const priceElement = item.querySelector('.price');
                
                if (linkElement && priceElement) {
                    const originalName = linkElement.textContent.trim();
                    const price = priceElement.textContent.trim();
                    const url = linkElement.href;
                    
                    gameList.push({ 
                        originalName: originalName,
                        price, 
                        url,
                        id: `game_${Date.now()}_${index}`
                    });
                }
            });
            
            return gameList;
        });
        
        await page.close();
        
        console.log(`\n=== CDKeys 게임명 정리 시작 (PC, DLC 제거) ===`);
        console.log(`⏰ 시간: 2025-08-17 16:03:20 UTC`);
        console.log(`👤 사용자: wogho`);
        
        const processedGames = games.map((game) => {
            const cleanName = cleanGameName(game.originalName);
            
            return {
                ...game,
                name: cleanName
            };
        });
        
        const changedCount = processedGames.filter(game => game.name !== game.originalName).length;
        console.log(`📊 총 ${processedGames.length}개 게임, ${changedCount}개 게임명 정리됨`);
        
        cache.set(cacheKey, processedGames);
        return processedGames;
        
    } catch (error) {
        console.error('CDKeys 크롤링 오류:', error);
        throw error;
    }
}

// Steam API 다단계 검색 로직
async function searchSteamGame(gameName) {
    const originalGameName = gameName;
    
    const searchAttempts = [
        gameName,                                           // 1단계: 입력된 게임명 그대로
        cleanGameName(gameName),                           // 2단계: 기본 정리
        gameName.replace(/\s+(PC|Mac|Linux).*$/i, ''),     // 3단계: 플랫폼 제거
        gameName.replace(/\s+(DLC|Expansion).*$/i, ''),    // 4단계: DLC 제거
        gameName.replace(/\s*:\s*.*$/i, ''),               // 5단계: 콜론 이후 제거
        gameName.replace(/\s*-\s*.*$/i, ''),               // 6단계: 대시 이후 제거
        gameName.split(' ').slice(0, -1).join(' '),       // 7단계: 마지막 단어 제거
        gameName.split(' ').slice(0, -2).join(' '),       // 8단계: 마지막 2단어 제거
    ];
    
    const uniqueAttempts = [...new Set(searchAttempts)]
        .filter(name => name && name.trim().length > 2);
    
    console.log(`🔍 "${originalGameName}" 다단계 검색 시작 (${uniqueAttempts.length}개 패턴)`);
    
    for (let i = 0; i < uniqueAttempts.length; i++) {
        const attemptName = uniqueAttempts[i].trim();
        const cacheKey = `steam_search_${attemptName}`;
        
        const cached = cache.get(cacheKey);
        if (cached) {
            console.log(`✅ Steam 게임 검색 캐시 사용 (${i+1}단계): "${attemptName}"`);
            return cached;
        }
        
        try {
            const searchUrl = `${STEAM_STORE_API_BASE}/storesearch/?term=${encodeURIComponent(attemptName)}&l=korean&cc=KR`;
            
            console.log(`🔍 Steam API 게임 검색 (${i+1}/${uniqueAttempts.length}단계): "${attemptName}"`);
            
            const response = await axios.get(searchUrl, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (response.data && response.data.items && response.data.items.length > 0) {
                const bestMatch = response.data.items.find(item => 
                    item.type === 'game' || item.type === 'dlc'
                ) || response.data.items[0];

                if (bestMatch) {
                    const result = {
                        appid: bestMatch.id,
                        name: bestMatch.name,
                        type: bestMatch.type,
                        source: `Steam API (${i+1}단계: "${attemptName}")`
                    };
                    
                    cache.set(cacheKey, result);
                    console.log(`✅ Steam 게임 발견 (${i+1}단계): "${originalGameName}" → "${bestMatch.name}" (ID: ${bestMatch.id})`);
                    console.log(`🎯 성공한 검색어: "${attemptName}"`);
                    return result;
                }
            }
            
            console.log(`❌ ${i+1}단계 실패: "${attemptName}"`);
            
            if (i < uniqueAttempts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
        } catch (error) {
            console.error(`Steam 게임 검색 오류 (${i+1}단계 "${attemptName}"):`, error.message);
        }
    }

    console.log(`❌ Steam API에서 게임을 찾을 수 없음 (모든 ${uniqueAttempts.length}단계 실패): "${originalGameName}"`);
    console.log(`🔍 시도된 검색어들: ${uniqueAttempts.map(name => `"${name}"`).join(', ')}`);
    return null;
}

// App ID로 직접 Steam 가격 정보 가져오기
async function fetchSteamPriceByAppId(appId, gameName = '') {
    const cacheKey = `steam_price_appid_${appId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Steam 가격 캐시 사용 (App ID ${appId}): ${gameName}`);
        return cached;
    }

    try {
        console.log(`📊 App ID ${appId}로 Steam 가격 정보 조회 시작`);
        
        const priceUrl = `${STEAM_STORE_API_BASE}/appdetails?appids=${appId}&cc=KR&l=korean&filters=price_overview,name`;
        
        const response = await axios.get(priceUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const appData = response.data[appId];
        
        if (appData && appData.success && appData.data) {
            const gameData = appData.data;
            const priceOverview = gameData.price_overview;
            
            let result = {
                exactName: gameData.name || gameName,
                appid: appId
            };

            if (priceOverview) {
                result.original = formatPriceFromCents(priceOverview.initial || priceOverview.final);
                result.final = formatPriceFromCents(priceOverview.final);
                
                if (priceOverview.discount_percent > 0) {
                    result.discount = `-${priceOverview.discount_percent}%`;
                }
            } else {
                result.original = "무료";
                result.final = "무료";
            }

            cache.set(cacheKey, result);
            console.log(`✅ App ID ${appId} 가격 정보 획득: ${result.exactName} - ${result.final}`);
            return result;
        }

        console.log(`❌ App ID ${appId} 가격 정보를 가져올 수 없음`);
        return null;

    } catch (error) {
        console.error(`App ID ${appId} 가격 정보 오류:`, error.message);
        return null;
    }
}

// Steam API를 이용한 게임 가격 정보 가져오기
async function fetchSteamPrice(gameName) {
    const cacheKey = `steam_price_${gameName}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Steam 가격 캐시 사용: ${gameName}`);
        return cached;
    }

    try {
        const gameInfo = await searchSteamGame(gameName);
        if (!gameInfo) {
            return null;
        }

        const result = await fetchSteamPriceByAppId(gameInfo.appid, gameName);
        if (result) {
            result.source = gameInfo.source;
            cache.set(cacheKey, result);
        }
        
        return result;

    } catch (error) {
        console.error(`Steam 가격 정보 오류 (${gameName}):`, error.message);
        return null;
    }
}

// Steam API를 이용한 게임 상세 정보 가져오기 (엑셀용)
async function getSteamGameInfo(gameName) {
    console.log(`Steam API에서 "${gameName}" 게임 정보 수집 시작`);
    
    try {
        const gameInfo = await searchSteamGame(gameName);
        if (!gameInfo) {
            return {
                headerImage: '',
                screenshots: [],
                developer: '',
                title: gameName
            };
        }

        const detailsUrl = `${STEAM_STORE_API_BASE}/appdetails?appids=${gameInfo.appid}&cc=KR&l=korean`;
        
        const response = await axios.get(detailsUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const appData = response.data[gameInfo.appid];
        
        if (appData && appData.success && appData.data) {
            const gameData = appData.data;
            
            const result = {
                title: gameData.name || gameName,
                headerImage: gameData.header_image || '',
                developer: (gameData.developers && gameData.developers[0]) || 'Unknown Developer',
                screenshots: []
            };

            if (gameData.screenshots && gameData.screenshots.length > 0) {
                result.screenshots = gameData.screenshots
                    .slice(0, 4)
                    .map(screenshot => screenshot.path_full);
            }

            console.log(`Steam API 게임 정보 수집 완료: ${result.title}`);
            return result;
        }

        return {
            headerImage: '',
            screenshots: [],
            developer: 'Unknown Developer',
            title: gameName
        };

    } catch (error) {
        console.error(`Steam API 게임 정보 수집 오류:`, error.message);
        return {
            headerImage: '',
            screenshots: [],
            developer: 'Unknown Developer',
            title: gameName
        };
    }
}

function formatPriceFromCents(cents) {
    if (!cents || cents === 0) return "무료";
    const actualPrice = Math.round(cents / 100);
    return `₩${actualPrice.toLocaleString('ko-KR')}`;
}

async function getKoreanGameName(englishName) {
    try {
        const gameInfo = await searchSteamGame(englishName);
        if (!gameInfo) {
            return "";
        }

        const detailsUrl = `${STEAM_STORE_API_BASE}/appdetails?appids=${gameInfo.appid}&cc=KR&l=korean`;
        
        const response = await axios.get(detailsUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const appData = response.data[gameInfo.appid];
        
        if (appData && appData.success && appData.data && appData.data.name) {
            const koreanName = appData.data.name;
            
            if (koreanName === englishName) {
                return "";
            }
            
            console.log(`한국어 제목 발견: ${englishName} → ${koreanName}`);
            return koreanName;
        }

        return "";
        
    } catch (error) {
        console.error(`한국어 제목 가져오기 오류 (${englishName}):`, error.message);
        return "";
    }
}

// 가격 파싱
function parsePrice(priceString) {
    if (!priceString) return 0;
    
    if (priceString === "무료" || priceString.toLowerCase().includes('free')) return 0;
    
    if (priceString.includes('₩')) {
        return parseInt(priceString.replace(/[₩,\s]/g, ''));
    }
    
    if (priceString.includes('$')) {
        const dollars = parseFloat(priceString.replace(/[$,\s]/g, ''));
        return Math.round(dollars * 1320);
    }
    
    if (priceString.includes('€')) {
        const euros = parseFloat(priceString.replace(/[€,\s]/g, ''));
        return Math.round(euros * 1430);
    }
    
    if (priceString.includes('£')) {
        const pounds = parseFloat(priceString.replace(/[£,\s]/g, ''));
        return Math.round(pounds * 1670);
    }
    
    return 0;
}

function sanitizeProductName(name) {
    return name.replace(/[\\*?"<>|:/]/g, '').trim();
}

// API 엔드포인트들

// App ID로 Steam 정보 재조회
app.post('/api/refresh-steam-info', async (req, res) => {
    const { gameId, appId, allGames } = req.body;
    
    if (!gameId || !appId) {
        return res.status(400).json({ error: 'Game ID와 App ID가 필요합니다.' });
    }
    
    try {
        console.log(`🔄 App ID ${appId}로 Steam 정보 재조회 시작 (Game ID: ${gameId})`);
        
        const gameIndex = allGames.findIndex(game => game.id === gameId);
        if (gameIndex === -1) {
            return res.status(404).json({ error: '게임을 찾을 수 없습니다.' });
        }
        
        const game = allGames[gameIndex];
        
        const steamPrice = await fetchSteamPriceByAppId(appId, game.name);
        
        if (steamPrice && steamPrice.final !== "무료") {
            const cdkeysPrice = parsePrice(game.price);
            const steamOriginalPrice = parsePrice(steamPrice.original);
            const steamFinalPrice = parsePrice(steamPrice.final);
            const savings = steamOriginalPrice - cdkeysPrice;
            
            const updatedGame = {
                ...game,
                exactName: steamPrice.exactName || game.name,
                steamOriginalPrice,
                steamFinalPrice,
                steamDiscount: steamPrice.discount,
                savings,
                savingsPercent: Math.round((savings / steamOriginalPrice) * 100),
                steamAppId: steamPrice.appid,
                source: `Manual App ID: ${appId}`
            };
            
            console.log(`✅ App ID ${appId} 정보 갱신 완료: ${updatedGame.exactName}`);
            
            res.json({
                success: true,
                game: updatedGame,
                gameIndex
            });
        } else {
            res.status(404).json({ 
                error: `App ID ${appId}에서 가격 정보를 찾을 수 없습니다.` 
            });
        }
        
    } catch (error) {
        console.error('Steam 정보 재조회 오류:', error);
        res.status(500).json({ 
            error: 'Steam 정보 재조회 중 오류가 발생했습니다.',
            details: error.message 
        });
    }
});

// 가격 비교
app.post('/api/compare', async (req, res) => {
    const { url, minDifference = 5000 } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'CDKeys URL이 필요합니다.' });
    }
    
    try {
        console.log('=== 가격 비교 시작 (다단계 Steam 검색 로직 적용) ===');
        console.log(`URL: ${url}`);
        console.log(`최소 차액: ${minDifference}원`);
        console.log(`시간: 2025-08-17 16:03:20 UTC`);
        console.log(`사용자: wogho`);
        
        const cdkeysGames = await fetchCDKeysGames(url);
        
        if (cdkeysGames.length === 0) {
            return res.json({ 
                success: true, 
                games: [],
                message: '게임을 찾을 수 없습니다.' 
            });
        }
        
        const comparisons = [];
        const notFoundGames = [];
        
        for (const game of cdkeysGames) {
            try {
                const steamPrice = await fetchSteamPrice(game.name);
                
                if (steamPrice && steamPrice.final !== "무료") {
                    const cdkeysPrice = parsePrice(game.price);
                    const steamOriginalPrice = parsePrice(steamPrice.original);
                    const steamFinalPrice = parsePrice(steamPrice.final);
                    const savings = steamOriginalPrice - cdkeysPrice;
                    
                    console.log(`💰 "${game.name}": CDKeys ${cdkeysPrice}원 vs Steam ${steamOriginalPrice}원 (절약: ${savings}원) [${steamPrice.source}]`);
                    
                    const gameData = {
                        id: game.id,
                        name: game.name,
                        originalName: game.originalName,
                        exactName: steamPrice.exactName || game.name,
                        cdkeysPrice,
                        cdkeysUrl: game.url,
                        steamOriginalPrice,
                        steamFinalPrice,
                        steamDiscount: steamPrice.discount,
                        savings,
                        savingsPercent: Math.round((savings / steamOriginalPrice) * 100),
                        steamAppId: steamPrice.appid,
                        source: steamPrice.source,
                        steamFound: true
                    };
                    
                    if (savings >= minDifference) {
                        comparisons.push(gameData);
                    }
                } else {
                    console.log(`❌ Steam API에서 찾을 수 없음: "${game.name}"`);
                    notFoundGames.push({
                        ...game,
                        steamFound: false,
                        reason: 'Steam API에서 정보 없음 (모든 단계 실패)'
                    });
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`게임 비교 오류 (${game.name}):`, error.message);
                notFoundGames.push({
                    ...game,
                    steamFound: false,
                    reason: `오류: ${error.message}`
                });
            }
        }

        comparisons.sort((a, b) => b.savings - a.savings);
        
        console.log(`=== 비교 완료: ${comparisons.length}개 할인 게임 발견, ${notFoundGames.length}개 미발견 ===`);
        
        res.json({
            success: true,
            totalGames: cdkeysGames.length,
            discountedGames: comparisons.length,
            notFoundGames: notFoundGames.length,
            games: comparisons,
            notFound: notFoundGames
        });
        
    } catch (error) {
        console.error('비교 처리 오류:', error);
        res.status(500).json({ 
            error: '가격 비교 중 오류가 발생했습니다.',
            details: error.message 
        });
    }
});

// 엑셀 내보내기 API
app.post('/api/export-excel', async (req, res) => {
    try {
        const { games, user = 'wogho', timestamp = new Date().toISOString() } = req.body;
        
        console.log(`\n=== 엑셀 내보내기 시작 (wogho님 정확한 고정값) ===`);
        console.log(`👤 사용자: ${user}`);
        console.log(`📅 시간: 2025-08-17 16:03:20 UTC`);
        console.log(`📊 선택된 게임 수: ${games.length}개`);
        
        if (!games || games.length === 0) {
            return res.status(400).json({
                success: false,
                error: '내보낼 게임이 없습니다.'
            });
        }
        
        const excelData = [];
        
        // A1 셀에 "상품 기본정보" 헤더 추가
        const headerRow = ["상품 기본정보"];
        for (let i = 1; i < 80; i++) {
            headerRow.push("");
        }
        excelData.push(headerRow);
        
        // A2부터 완전한 스토어 양식 헤더 (80개 컬럼)
        const columnHeaders = [
            "판매자 상품코드", "카테고리코드", "상품명", "상품상태", "판매가", "부가세", "재고수량", 
            "옵션형태", "옵션명", "옵션값", "옵션가", "옵션 재고수량", "직접입력 옵션", "추가상품명", 
            "추가상품값", "추가상품가", "추가상품 재고수량", "대표이미지", "추가이미지", "상세설명", 
            "브랜드", "제조사", "제조일자", "유효일자", "원산지코드", "수입사", "복수원산지여부", 
            "원산지 직접입력", "미성년자 구매", "배송비 템플릿코드", "배송방법", "택배사코드", 
            "배송비유형", "기본배송비", "배송비 결제방식", "조건부무료- 상품판매가 합계", 
            "수량별부과-수량", "구간별- 2구간수량", "구간별- 3구간수량", "구간별- 3구간배송비", 
            "구간별- 추가배송비", "반품배송비", "교환배송비", "지역별 차등 배송비", "별도설치비", 
            "상품정보제공고시 템플릿코드", "상품정보제공고시 품명", "상품정보제공고시 모델명", 
            "상품정보제공고시 인증허가사항", "상품정보제공고시 제조자", "A/S 템플릿코드", 
            "A/S 전화번호", "A/S 안내", "판매자특이사항", "즉시할인 값 (기본할인)", 
            "즉시할인 단위 (기본할인)", "모바일 즉시할인 값", "모바일 즉시할인 단위", 
            "복수구매할인 조건 값", "복수구매할인 조건 단위", "복수구매할인 값", "복수구매할인 단위", 
            "상품구매시 포인트 지급 값", "상품구매시 포인트 지급 단위", "텍스트리뷰 작성시 지급 포인트", 
            "포토/동영상 리뷰 작성시 지급 포인트", "한달사용 텍스트리뷰 작성시 지급 포인트", 
            "한달사용 포토/동영상리뷰 작성시 지급 포인트", "알림받기동의 고객 리뷰 작성 시 지급 포인트", 
            "무이자 할부 개월", "사은품", "판매자바코드", "구매평 노출여부", "구매평 비노출사유", 
            "알림받기 동의 고객 전용 여부", "ISBN", "ISSN", "독립출판", "출간일", "출판사", 
            "글작가", "그림작가", "번역자명", "문화비 소득공제", "사이즈 상품군", "사이즈 사이즈명", 
            "사이즈 상세 사이즈", "사이즈 모델명"
        ];
        
        excelData.push(columnHeaders);
        
        console.log(`✅ A1 헤더 및 컬럼 헤더 생성 완료: ${columnHeaders.length}개 컬럼`);
        
        // 각 게임별로 Steam 정보 처리
        for (const game of games) {
            console.log(`🔄 "${game.name}" 게임 정보 처리 중...`);
            
            try {
                const steamInfo = await getSteamGameInfo(game.name);
                const koreanName = await getKoreanGameName(game.name);
                const cleanGameName = sanitizeProductName(game.name);
                
                const productName = koreanName 
                    ? `[우회X 한국코드] ${cleanGameName} ${sanitizeProductName(koreanName)} 스팀 키`
                    : `[우회X 한국코드] ${cleanGameName} 스팀 키`;
                
                const additionalImages = steamInfo.screenshots.join('\n');
                
                const detailDescription = steamInfo.screenshots
                    .map(url => `<img src="${url}" style="opacity: 1; max-width: 803px; max-height: 550px;">`)
                    .join('\n');
                
                const row = [
                    "", // 0. 판매자 상품코드
                    "50001735", // 1. 카테고리코드 ✅
                    productName, // 2. 상품명
                    "신상품", // 3. 상품상태 ✅
                    game.sellPrice || game.cdkeysPrice, // 4. 판매가
                    "과세상품", // 5. 부가세 ✅
                    "5", // 6. 재고수량 ✅
                    "단독형", // 7. 옵션형태 ✅
                    "메일주소필수기입", // 8. 옵션명 ✅
                    game.name, // 9. 옵션값
                    "", // 10. 옵션가
                    "", // 11. 옵션 재고수량
                    "", // 12. 직접입력 옵션
                    "", // 13. 추가상품명
                    "", // 14. 추가상품값
                    "", // 15. 추가상품가
                    "", // 16. 추가상품 재고수량
                    steamInfo.headerImage, // 17. 대표이미지
                    additionalImages, // 18. 추가이미지
                    detailDescription, // 19. 상세설명
                    steamInfo.developer || 'Unknown Developer', // 20. 브랜드
                    steamInfo.developer || 'Unknown Developer', // 21. 제조사
                    "", // 22. 제조일자
                    "", // 23. 유효일자
                    "03", // 24. 원산지코드 ✅
                    "", // 25. 수입사
                    "N", // 26. 복수원산지여부 ✅
                    "상세설명에 표시", // 27. 원산지 직접입력 ✅
                    "Y", // 28. 미성년자 구매 ✅
                    "", // 29. 배송비 템플릿코드 ✅
                    "직접배송(화물배달)", // 30. 배송방법 ✅
                    "", // 31. 택배사코드
                    "무료", // 32. 배송비유형 ✅
                    "0", // 33. 기본배송비 ✅
                    "", // 34. 배송비 결제방식
                    "", // 35. 조건부무료- 상품판매가 합계 ✅
                    "", // 36. 수량별부과-수량 ✅
                    "", // 37. 구간별- 2구간수량
                    "", // 38. 구간별- 3구간수량
                    "", // 39. 구간별- 3구간배송비
                    "", // 40. 구간별- 추가배송비
                    "0", // 41. 반품배송비 ✅
                    "0", // 42. 교환배송비 ✅
                    "", // 43. 지역별 차등 배송비
                    "0", // 44. 별도설치비 ✅
                    "", // 45. 상품정보제공고시 템플릿코드
                    "", // 46. 상품정보제공고시 품명
                    "", // 47. 상품정보제공고시 모델명
                    "", // 48. 상품정보제공고시 인증허가사항
                    "", // 49. 상품정보제공고시 제조자
                    "3235865", // 50. A/S 템플릿코드 ✅
                    "050714090848", // 51. A/S 전화번호 ✅
                    "050714090848", // 52. A/S 안내 ✅
                    "", // 53. 판매자특이사항
                    "", // 54. 즉시할인 값 (기본할인)
                    "", // 55. 즉시할인 단위 (기본할인)
                    "", // 56. 모바일 즉시할인 값
                    "", // 57. 모바일 즉시할인 단위
                    "", // 58. 복수구매할인 조건 값
                    "", // 59. 복수구매할인 조건 단위
                    "", // 60. 복수구매할인 값
                    "", // 61. 복수구매할인 단위
                    "", // 62. 상품구매시 포인트 지급 값
                    "", // 63. 상품구매시 포인트 지급 단위
                    "", // 64. 텍스트리뷰 작성시 지급 포인트
                    "", // 65. 포토/동영상 리뷰 작성시 지급 포인트
                    "", // 66. 한달사용 텍스트리뷰 작성시 지급 포인트
                    "", // 67. 한달사용 포토/동영상리뷰 작성시 지급 포인트
                    "", // 68. 알림받기동의 고객 리뷰 작성 시 지급 포인트
                    "", // 69. 무이자 할부 개월
                    "", // 70. 사은품
                    "", // 71. 판매자바코드
                    "Y", // 72. 구매평 노출여부 ✅
                    "", // 73. 구매평 비노출사유
                    "N", // 74. 알림받기 동의 고객 전용 여부 ✅
                    "", "", "", "", "", "", "", "", "", "" // 75-79번까지 빈칸
                ];
                
                excelData.push(row);
                console.log(`✅ "${game.name}" 게임 데이터 추가 완료`);
                
            } catch (error) {
                console.error(`게임 정보 처리 오류 (${game.name}):`, error.message);
                
                const basicRow = new Array(80).fill("");
                basicRow[1] = "50001735";
                basicRow[2] = `[우회X 한국코드] ${game.name} 스팀 키`;
                basicRow[3] = "신상품";
                basicRow[4] = game.sellPrice || game.cdkeysPrice;
                basicRow[5] = "과세상품";
                basicRow[6] = "5";
                basicRow[7] = "단독형";
                basicRow[8] = "메일주소필수기입";
                basicRow[9] = game.name;
                basicRow[20] = "Unknown Developer";
                basicRow[21] = "Unknown Developer";
                basicRow[24] = "03";
                basicRow[26] = "N";
                basicRow[27] = "상세설명에 표시";
                basicRow[28] = "Y";
                basicRow[30] = "직접배송(화물배달)";
                basicRow[32] = "무료";
                basicRow[33] = "0";
                basicRow[41] = "0";
                basicRow[42] = "0";
                basicRow[44] = "0";
                basicRow[50] = "3235865";
                basicRow[51] = "050714090848";
                basicRow[52] = "050714090848";
                basicRow[72] = "Y";
                basicRow[74] = "N";
                
                excelData.push(basicRow);
                console.log(`⚠️ "${game.name}" 게임 기본 데이터 추가`);
            }
        }
        
        // 엑셀 파일 생성
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.aoa_to_sheet(excelData);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Games');
        
        // exports 디렉토리 생성
        const exportsDir = path.join(__dirname, 'exports');
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }
        
        const fileName = `game_store_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).substr(2, 6)}.xlsx`;
        const filePath = path.join(exportsDir, fileName);
        
        xlsx.writeFile(workbook, filePath);
        
        console.log(`✅ 엑셀 파일 생성 완료: ${fileName}`);
        console.log(`📊 총 ${excelData.length}행`);
        
        // 파일 다운로드
        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error('파일 다운로드 오류:', err);
                res.status(500).json({
                    success: false,
                    error: '파일 다운로드 중 오류가 발생했습니다.'
                });
            } else {
                // 5초 후 임시 파일 삭제
                setTimeout(() => {
                    fs.unlink(filePath, (unlinkErr) => {
                        if (unlinkErr) console.error('임시 파일 삭제 오류:', unlinkErr);
                        else console.log(`🗑️ 임시 파일 삭제: ${fileName}`);
                    });
                }, 5000);
            }
        });
        
    } catch (error) {
        console.error('❌ 엑셀 내보내기 오류:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 관리용 엑셀 내보내기 API
app.post('/api/export-excel-management', async (req, res) => {
    try {
        const { games, user = 'wogho', timestamp = new Date().toISOString() } = req.body;
        
        console.log(`\n=== 관리용 엑셀 내보내기 시작 ===`);
        console.log(`👤 사용자: ${user}`);
        console.log(`📅 시간: 2025-08-17 16:03:20 UTC`);
        console.log(`📊 선택된 게임 수: ${games.length}개`);
        console.log(`💰 A5 판매가 정책: 사용자 입력값 - 500원 고정`);
        
        if (!games || games.length === 0) {
            return res.status(400).json({
                success: false,
                error: '내보낼 게임이 없습니다.'
            });
        }
        
        const excelData = [];
        
        // 각 게임별로 관리용 데이터 처리
        for (const game of games) {
            console.log(`🔄 관리용 데이터 처리: "${game.name}"`);
            
            try {
                const koreanName = await getKoreanGameName(game.name);
                const cleanGameName = sanitizeProductName(game.name);
                
                const productName = koreanName 
                    ? `[우회X 한국코드] ${cleanGameName} ${sanitizeProductName(koreanName)} 스팀 키`
                    : `[우회X 한국코드] ${cleanGameName} 스팀 키`;
                
                // A5 판매가 계산: 사용자 입력값 - 500원 고정
                const originalSellPrice = game.sellPrice || 0;
                const adjustedSellPrice = Math.max(0, originalSellPrice - 500);
                
                console.log(`💰 "${game.name}" 가격 조정: ${originalSellPrice}원 → ${adjustedSellPrice}원 (-500원)`);
                
                // 관리용 데이터 배열 (A1~A7)
                const gameData = [
                    productName,                    // A1: 상품명
                    "",                            // A2: 빈칸
                    game.cdkeysUrl || "",          // A3: CDKeys 구매 링크
                    "0",                           // A4: 0
                    adjustedSellPrice,             // A5: 판매가 (-500원) ✅
                    "0",                           // A6: 0
                    game.cdkeysPrice || 0          // A7: CDKeys 가격
                ];
                
                excelData.push(gameData);
                console.log(`✅ "${game.name}" 관리용 데이터 추가 완료 (A5: ${adjustedSellPrice}원)`);
                
            } catch (error) {
                console.error(`관리용 데이터 처리 오류 (${game.name}):`, error.message);
                
                const originalSellPrice = game.sellPrice || 0;
                const adjustedSellPrice = Math.max(0, originalSellPrice - 500);
                
                const basicData = [
                    `[우회X 한국코드] ${sanitizeProductName(game.name)} 스팀 키`,
                    "",
                    game.cdkeysUrl || "",
                    "0",
                    adjustedSellPrice,
                    "0",
                    game.cdkeysPrice || 0
                ];
                
                excelData.push(basicData);
                console.log(`⚠️ "${game.name}" 기본 관리용 데이터 추가 (A5: ${adjustedSellPrice}원)`);
            }
        }
        
        // 엑셀 파일 생성
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.aoa_to_sheet(excelData);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Management');
        
        // exports 디렉토리 생성
        const exportsDir = path.join(__dirname, 'exports');
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }
        
        const fileName = `game_management_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).substr(2, 6)}.xlsx`;
        const filePath = path.join(exportsDir, fileName);
        
        xlsx.writeFile(workbook, filePath);
        
        console.log(`✅ 관리용 엑셀 파일 생성 완료: ${fileName}`);
        console.log(`📊 총 ${excelData.length}행`);
        console.log(`📋 컬럼: A1(상품명), A2(빈칸), A3(CDKeys링크), A4(0), A5(판매가-500), A6(0), A7(CDKeys가격)`);
        
        // 파일 다운로드
        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error('관리용 파일 다운로드 오류:', err);
                res.status(500).json({
                    success: false,
                    error: '파일 다운로드 중 오류가 발생했습니다.'
                });
            } else {
                // 5초 후 임시 파일 삭제
                setTimeout(() => {
                    fs.unlink(filePath, (unlinkErr) => {
                        if (unlinkErr) console.error('임시 파일 삭제 오류:', unlinkErr);
                        else console.log(`🗑️ 임시 파일 삭제: ${fileName}`);
                    });
                }, 5000);
            }
        });
        
    } catch (error) {
        console.error('❌ 관리용 엑셀 내보내기 오류:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 캐시 삭제
app.delete('/api/cache', (req, res) => {
    cache.flushAll();
    console.log('캐시 초기화 완료');
    res.json({ success: true, message: '캐시가 초기화되었습니다.' });
});

// 서버 상태
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        cache: {
            keys: cache.keys().length,
            stats: cache.getStats()
        },
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        features: [
            'CDKeys Crawling (Enhanced PC/DLC Removal)',
            'Steam API Multi-Stage Search',
            'Manual App ID Input',
            'Excel Export (wogho Fixed Values)',
            'Excel Export Management',
            'Cache Management',
            'Game Name Cleaning System'
        ],
        user: 'wogho',
        timestamp: '2025-08-17 16:03:20 UTC',
        steamSource: 'Steam API Multi-Stage Search',
        cleaningPatterns: [
            'PC (various formats)',
            'DLC (various formats)', 
            'Steam (various formats)',
            'Key/Code suffixes',
            'Digital/Download suffixes',
            'Regional indicators (Global, EU, US, UK)',
            'Platform identifiers'
        ],
        searchStages: [
            '1단계: 원본 게임명',
            '2단계: 기본 정리',
            '3단계: 플랫폼 제거',
            '4단계: DLC 제거',
            '5단계: 콜론 이후 제거',
            '6단계: 대시 이후 제거',
            '7단계: 마지막 단어 제거',
            '8단계: 마지막 2단어 제거'
        ]
    });
});

// 게임명 정리 테스트
app.post('/api/test-clean-name', (req, res) => {
    const { gameName } = req.body;
    
    if (!gameName) {
        return res.status(400).json({ error: '게임명이 필요합니다.' });
    }
    
    try {
        const cleanedName = cleanGameName(gameName);
        
        res.json({
            success: true,
            original: gameName,
            cleaned: cleanedName,
            changed: gameName !== cleanedName,
            timestamp: '2025-08-17 16:03:20 UTC',
            user: 'wogho'
        });
        
    } catch (error) {
        console.error('게임명 정리 테스트 오류:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
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
    CDKeys-Steam 가격 비교 서버 (다단계 검색 로직)
    포트: ${PORT}
    URL: http://0.0.0.0:${PORT}
    외부 접속: http://140.238.30.184:${PORT}
    사용자: wogho
    시간: 2025-08-17 16:03:20 UTC
    
    🚀 다단계 Steam 검색 로직 적용:
    1단계: 원본 게임명 → 2단계: 기본 정리
    3단계: 플랫폼 제거 → 4단계: DLC 제거
    5단계: 콜론 이후 제거 → 6단계: 대시 이후 제거
    7단계: 마지막 단어 제거 → 8단계: 마지막 2단어 제거
    
    🎯 wogho님 요청사항 100% 반영 완료!
    ========================================
    `);
    
    // 브라우저 사전 초기화
    initBrowser().then(() => {
        console.log('Puppeteer 브라우저 준비 완료 (다단계 검색 로직 적용)');
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