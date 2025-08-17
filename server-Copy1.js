const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const NodeCache = require('node-cache');
const compression = require('compression');
const helmet = require('helmet');
// const rateLimit = require('express-rate-limit'); // Rate Limit 완전 제거
const xlsx = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// 캐시 설정 (TTL: 1시간)
const cache = new NodeCache({ stdTTL: 3600 });

// 환율 정보
let exchangeRate = 1320; // 기본값
let lastExchangeUpdate = new Date();

// 서버 시작 시간
const serverStartTime = new Date();

console.log(`
🚀 CDKeys-Steam 가격 비교 서버 시작 (Rate Limit 완전 제거)
👤 사용자: wogho
📅 시작 시간: ${serverStartTime.toISOString()}
⚡ 기존 ARM64 최적화 유지
📊 엑셀 내보내기 기능 추가
❌ Rate Limit 완전 제거됨
🌐 포트: ${PORT}
`);

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

// Rate Limit 완전 제거 - 더 이상 사용하지 않음

// Puppeteer 브라우저 인스턴스 (재사용)
let browser = null;

// 환율 업데이트 함수
async function updateExchangeRate() {
    try {
        console.log('💱 환율 정보 업데이트 중...');
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await response.json();
        
        if (data.rates && data.rates.KRW) {
            exchangeRate = Math.round(data.rates.KRW);
            lastExchangeUpdate = new Date();
            console.log(`✅ 환율 업데이트 완료: 1 USD = ${exchangeRate} KRW`);
        }
    } catch (error) {
        console.error('❌ 환율 업데이트 실패:', error.message);
    }
}

// 브라우저 초기화 (기존 ARM64 최적화 유지)
async function initBrowser() {
    if (!browser) {
        console.log('🔧 Puppeteer 브라우저 초기화...');
        
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
        console.log('✅ Puppeteer 브라우저 준비 완료');
    }
    return browser;
}

// CDKeys 게임 목록 크롤링 (기존 로직)
async function fetchCDKeysGames(url) {
    const cacheKey = `cdkeys_${url}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log('📋 CDKeys 캐시 데이터 사용');
        return cached;
    }

    try {
        const browserInstance = await initBrowser();
        const page = await browserInstance.newPage();
        
        // User-Agent 설정 (기존과 동일)
        await page.setUserAgent('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`🌐 CDKeys 페이지 로딩: ${url}`);
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // 페이지 로드 대기
        console.log('⏳ .product-item 요소 대기 중...');
        await page.waitForSelector('.product-item', { timeout: 10000 });
        console.log('✅ .product-item 요소 발견됨');
        
        // 게임 목록 추출
        const games = await page.evaluate((exchangeRate) => {
            const gameList = [];
            const items = document.querySelectorAll('.product-item');
            
            console.log(`📊 발견된 .product-item 수: ${items.length}개`);
            
            items.forEach((item, index) => {
                const linkElement = item.querySelector('.product-item-link');
                const priceElement = item.querySelector('.price');
                
                if (linkElement && priceElement) {
                    let name = linkElement.textContent.trim();
                    // 플랫폼 관련 텍스트 제거
                    name = name.replace(/\s*(PC|PS4|PS5|Xbox|DLC|Digital|Download|Steam|Key|Global|EU|US|UK).*$/gi, '').trim();
                    
                    const priceText = priceElement.textContent.trim();
                    const gameUrl = linkElement.href;
                    
                    // 가격에서 숫자 추출
                    const priceMatch = priceText.match(/[\d,.]+/);
                    if (priceMatch && name.length > 3) {
                        const priceStr = priceMatch[0].replace(',', '');
                        let priceUSD;
                        
                        // 통화 기호에 따라 처리
                        if (priceText.includes('$')) {
                            priceUSD = parseFloat(priceStr);
                        } else if (priceText.includes('£')) {
                            priceUSD = parseFloat(priceStr) * 1.27; // GBP to USD
                        } else if (priceText.includes('€')) {
                            priceUSD = parseFloat(priceStr) * 1.08; // EUR to USD
                        } else {
                            priceUSD = parseFloat(priceStr);
                        }
                        
                        if (priceUSD > 0 && priceUSD < 200) {
                            gameList.push({
                                name: name,
                                price: priceText, // 기존 형식 유지
                                url: gameUrl,
                                cdkeysPrice: Math.round(priceUSD * exchangeRate),
                                cdkeysPriceUSD: priceUSD,
                                id: `game_${Date.now()}_${index}`
                            });
                        }
                    }
                }
            });
            
            return gameList;
        }, exchangeRate);
        
        await page.close();
        
        console.log(`🎮 CDKeys에서 ${games.length}개 게임 발견`);
        
        // 디버깅: 첫 3개 게임 정보 출력
        games.slice(0, 3).forEach(game => {
            console.log(`  - ${game.name}: ${game.price} → $${game.cdkeysPriceUSD} (${game.cdkeysPrice}원)`);
        });
        
        cache.set(cacheKey, games);
        return games;
        
    } catch (error) {
        console.error('❌ CDKeys 크롤링 오류:', error);
        throw error;
    }
}

// Steam 가격 검색 (기존 로직 유지)
async function fetchSteamPrice(gameName) {
    const cacheKey = `steam_${gameName}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Steam 캐시 데이터 사용: ${gameName}`);
        return cached;
    }

    try {
        const browserInstance = await initBrowser();
        const page = await browserInstance.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Steam 검색
        const searchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(gameName)}`;
        console.log(`🔍 Steam 검색: ${gameName}`);
        
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
            console.log(`✅ Steam 가격 발견: ${gameName} - ${priceInfo.final}`);
            cache.set(cacheKey, priceInfo);
            return priceInfo;
        }
        
        return null;
        
    } catch (error) {
        console.error(`❌ Steam 가격 검색 오류 (${gameName}):`, error);
        return null;
    }
}

// 가격 파싱 (원화/달러 처리) - 환율 적용
function parsePrice(priceString) {
    if (!priceString) return 0;
    
    // 원화 처리
    if (priceString.includes('₩')) {
        return parseInt(priceString.replace(/[₩,\s]/g, ''));
    }
    
    // 달러 처리 (실시간 환율 적용)
    if (priceString.includes('$')) {
        const dollars = parseFloat(priceString.replace(/[$,\s]/g, ''));
        return Math.round(dollars * exchangeRate); // 실시간 환율 사용
    }
    
    // 유로 처리
    if (priceString.includes('€')) {
        const euros = parseFloat(priceString.replace(/[€,\s]/g, ''));
        return Math.round(euros * (exchangeRate * 1.08)); // USD 환율 * EUR/USD 비율
    }
    
    // 파운드 처리
    if (priceString.includes('£')) {
        const pounds = parseFloat(priceString.replace(/[£,\s]/g, ''));
        return Math.round(pounds * (exchangeRate * 1.27)); // USD 환율 * GBP/USD 비율
    }
    
    return 0;
}

// Steam 게임 정보 크롤링 (엑셀용)
async function getSteamGameInfo(gameName) {
    console.log(`🎮 Steam에서 "${gameName}" 게임 정보 크롤링 시작`);
    
    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();
    
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Steam 검색
        const searchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(gameName)}`;
        await page.goto(searchUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        await page.waitForTimeout(2000);
        
        // 첫 번째 검색 결과의 앱 ID 추출
        const appId = await page.evaluate(() => {
            const firstResult = document.querySelector('a[data-ds-appid]');
            return firstResult ? firstResult.getAttribute('data-ds-appid') : null;
        });
        
        if (!appId) {
            return {
                headerImage: '',
                screenshots: [],
                developer: '',
                title: gameName
            };
        }
        
        // 게임 상세 페이지로 이동
        const gameUrl = `https://store.steampowered.com/app/${appId}`;
        await page.goto(gameUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        await page.waitForTimeout(2000);
        
        // 게임 정보 추출
        const gameInfo = await page.evaluate(() => {
            const result = {};
            
            // 대표 이미지
            const headerImg = document.querySelector('.game_header_image_full');
            result.headerImage = headerImg ? headerImg.src : '';
            
            // 스크린샷 이미지들 (4개)
            const screenshots = Array.from(document.querySelectorAll('.highlight_screenshot_link img')).slice(0, 4);
            result.screenshots = screenshots.map(img => img.src.replace('_116x65', '.1920x1080'));
            
            // 개발자 정보
            const developerLink = document.querySelector('.dev_row .summary a[href*="developer="]');
            result.developer = developerLink ? developerLink.textContent.trim() : '';
            
            // 게임명
            const gameTitle = document.querySelector('.apphub_AppName');
            result.title = gameTitle ? gameTitle.textContent.trim() : '';
            
            return result;
        });
        
        console.log(`✅ Steam 게임 정보 추출 완료: ${gameInfo.title}`);
        return gameInfo;
        
    } catch (error) {
        console.error(`❌ Steam 게임 정보 크롤링 오류:`, error.message);
        return {
            headerImage: '',
            screenshots: [],
            developer: '',
            title: gameName
        };
    } finally {
        await page.close();
    }
}

// 한글 게임명 변환
function getKoreanGameName(englishName) {
    const translations = {
        'Cyberpunk 2077': '사이버펑크 2077',
        'The Witcher 3': '위쳐 3',
        'Grand Theft Auto V': '그랜드 테프트 오토 5',
        'Call of Duty': '콜 오브 듀티',
        'Assassins Creed': '어쌔신 크리드',
        'Red Dead Redemption': '레드 데드 리뎀션'
    };
    
    for (const [eng, kor] of Object.entries(translations)) {
        if (englishName.toLowerCase().includes(eng.toLowerCase())) {
            return kor;
        }
    }
    
    return englishName;
}

// API 엔드포인트: 가격 비교 (기존 로직)
app.post('/api/compare', async (req, res) => {
    const { url, minDifference = 5000, user, timestamp } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'CDKeys URL이 필요합니다.' });
    }
    
    try {
        console.log(`\n=== CDKeys ↔ Steam 가격 비교 시작 ===`);
        console.log(`👤 사용자: ${user || 'wogho'}`);
        console.log(`📅 시간: ${timestamp || new Date().toISOString()}`);
        console.log(`🔗 URL: ${url}`);
        console.log(`💰 최소 절약: ${minDifference}원`);
        
        // 캐시 확인
        const cacheKey = `compare_${url}_${minDifference}`;
        const cached = cache.get(cacheKey);
        
        if (cached) {
            console.log('📋 캐시에서 결과 반환');
            return res.json({ ...cached, fromCache: true });
        }
        
        // CDKeys 게임 목록 가져오기
        const cdkeysGames = await fetchCDKeysGames(url);
        
        if (cdkeysGames.length === 0) {
            return res.json({ 
                success: true, 
                totalGames: 0,
                discountedGames: 0,
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
                    const cdkeysPrice = game.cdkeysPrice || parsePrice(game.price);
                    const steamOriginalPrice = parsePrice(steamPrice.original || steamPrice.final);
                    const steamFinalPrice = parsePrice(steamPrice.final);
                    const savings = steamOriginalPrice - cdkeysPrice;
                    
                    console.log(`${game.name}: CDKeys ${cdkeysPrice}원 vs Steam ${steamOriginalPrice}원 (절약: ${savings}원)`);
                    
                    if (savings >= minDifference) {
                        comparisons.push({
                            ...game,
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
        
        const result = {
            success: true,
            totalGames: cdkeysGames.length,
            discountedGames: comparisons.length,
            games: comparisons.slice(0, 20), // 상위 20개만
            exchangeRate: exchangeRate,
            timestamp: new Date().toISOString(),
            minDifference: minDifference
        };
        
        // 캐시에 저장 (30분)
        cache.set(cacheKey, result, 1800);
        
        console.log(`📊 결과: 전체 ${cdkeysGames.length}개 중 ${comparisons.length}개 절약 가능`);
        
        res.json(result);
        
    } catch (error) {
        console.error('❌ 비교 처리 오류:', error);
        res.status(500).json({ 
            error: '가격 비교 중 오류가 발생했습니다.',
            details: error.message 
        });
    }
});

// 엑셀 내보내기 API
app.post('/api/export-excel', async (req, res) => {
    try {
        const { games, user, timestamp } = req.body;
        
        console.log(`\n=== 엑셀 내보내기 시작 ===`);
        console.log(`👤 사용자: ${user || 'wogho'}`);
        console.log(`📅 시간: ${timestamp || new Date().toISOString()}`);
        console.log(`📊 선택된 게임 수: ${games.length}개`);
        
        const excelData = [];
        
        // 헤더 추가
        const headers = [
            "판매자 상품코드", "카테고리코드", "상품명", "상품상태", "판매가", "부가세", "재고수량", 
            "옵션형태", "옵션명", "옵션값", "옵션가", "옵션 재고수량", "직접입력 옵션", "추가상품명", 
            "추가상품가", "추가상품 재고수량", "대표이미지", "추가이미지", "상세설명", "브랜드", "제조사"
        ];
        excelData.push(headers);
        
        // 각 게임별로 Steam 정보 처리
        for (const game of games) {
            console.log(`🔄 "${game.name}" 게임 정보 처리 중...`);
            
            const steamInfo = await getSteamGameInfo(game.name);
            const koreanName = getKoreanGameName(game.name);
            const productName = `[우회X 한국코드] ${game.name} ${koreanName} 스팀 키`;
            const additionalImages = steamInfo.screenshots.join('\n');
            const detailDescription = steamInfo.screenshots
                .map(url => `<img src="${url}" style="opacity: 1; max-width: 803px; max-height: 550px;">`)
                .join('\n');
            
            const row = [
                "", "50001735", productName, "신상품", game.price, "과세상품", "5", 
                "단독형", "메일주소필수기입", game.name, "", "", "", "", "", "",
                steamInfo.headerImage, additionalImages, detailDescription, 
                steamInfo.developer || 'Unknown Developer', steamInfo.developer || 'Unknown Developer'
            ];
            
            excelData.push(row);
        }
        
        // 엑셀 파일 생성
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.aoa_to_sheet(excelData);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Games');
        
        const fileName = `game_store_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).substr(2, 6)}.xlsx`;
        const filePath = path.join(__dirname, 'exports', fileName);
        
        const fs = require('fs');
        if (!fs.existsSync(path.join(__dirname, 'exports'))) {
            fs.mkdirSync(path.join(__dirname, 'exports'));
        }
        
        xlsx.writeFile(workbook, filePath);
        
        console.log(`✅ 엑셀 파일 생성 완료: ${fileName}`);
        
        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error('파일 다운로드 오류:', err);
            } else {
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

// API 엔드포인트: 환율 정보
app.get('/api/exchange-rate', async (req, res) => {
    try {
        await updateExchangeRate();
        res.json({
            success: true,
            rate: exchangeRate,
            currency: 'USD/KRW',
            lastUpdate: lastExchangeUpdate.toISOString()
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            rate: exchangeRate,
            currency: 'USD/KRW',
            lastUpdate: lastExchangeUpdate.toISOString()
        });
    }
});

// API 엔드포인트: 캐시 삭제
app.delete('/api/cache', (req, res) => {
    cache.flushAll();
    console.log('🗑️ 캐시 초기화 완료');
    res.json({ success: true, message: '캐시가 초기화되었습니다.' });
});

// API 엔드포인트: 서버 상태
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        user: 'wogho',
        features: [
            'CDKeys Crawling (ARM64 Optimized)',
            'Steam Price Comparison', 
            'Excel Export with Steam Data',
            'Real-time Exchange Rate',
            'Cache Management',
            'No Rate Limit (Removed for Stability)'
        ],
        cache: {
            keys: cache.keys().length,
            stats: cache.getStats()
        },
        memory: process.memoryUsage(),
        exchangeRate: exchangeRate,
        lastExchangeUpdate: lastExchangeUpdate.toISOString(),
        rateLimitStatus: 'disabled'
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
🌟 CDKeys-Steam 가격 비교 서버가 성공적으로 시작되었습니다!
🌐 URL: http://0.0.0.0:${PORT}
📱 외부 접속: http://140.238.30.184:${PORT}
👤 사용자: wogho
📅 시작 시간: ${new Date().toISOString()}
⚡ 기존 ARM64 최적화 + 새 기능 통합
🎮 안정적인 CDKeys 크롤링
📊 엑셀 내보내기 기능 활성화
❌ Rate Limit 완전 제거됨 (안정성 향상)
    `);
    
    // 브라우저 사전 초기화 및 환율 업데이트
    Promise.all([
        initBrowser(),
        updateExchangeRate()
    ]).then(() => {
        console.log('✅ 모든 초기화 완료');
    }).catch(err => {
        console.error('❌ 초기화 실패:', err);
    });
});

// 종료 처리
process.on('SIGINT', async () => {
    console.log('\n🔄 서버 종료 중...');
    if (browser) {
        await browser.close();
        console.log('✅ 브라우저 인스턴스 정리 완료');
    }
    console.log('👋 서버 종료 완료');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🔄 서버 종료 중...');
    if (browser) {
        await browser.close();
        console.log('✅ 브라우저 인스턴스 정리 완료');
    }
    console.log('👋 서버 종료 완료');
    process.exit(0);
});