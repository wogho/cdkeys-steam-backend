// server.js - CDKeys-Steam Price Comparison Backend with Steam API
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
            
            items.forEach((item, index) => {
                const linkElement = item.querySelector('.product-item-link');
                const priceElement = item.querySelector('.price');
                
                if (linkElement && priceElement) {
                    let name = linkElement.textContent.trim();
                    // 플랫폼 관련 텍스트 제거
                    name = name.replace(/\s*(PC|PS4|PS5|Xbox|DLC|Digital|Download|Steam|Key|Global|EU|US|UK).*$/gi, '').trim();
                    
                    const price = priceElement.textContent.trim();
                    const url = linkElement.href;
                    
                    gameList.push({ 
                        name, 
                        price, 
                        url,
                        id: `game_${Date.now()}_${index}`
                    });
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

// Steam API를 이용한 게임 검색
async function searchSteamGame(gameName) {
    const cacheKey = `steam_search_${gameName}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`Steam 게임 검색 캐시 사용: ${gameName}`);
        return cached;
    }

    try {
        const searchUrl = `${STEAM_STORE_API_BASE}/storesearch/?term=${encodeURIComponent(gameName)}&l=korean&cc=KR`;
        
        console.log(`Steam API 게임 검색: ${gameName}`);
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
                    type: bestMatch.type
                };
                
                cache.set(cacheKey, result);
                console.log(`Steam 게임 발견: ${bestMatch.name} (ID: ${bestMatch.id})`);
                return result;
            }
        }

        console.log(`Steam에서 게임을 찾을 수 없음: ${gameName}`);
        return null;

    } catch (error) {
        console.error(`Steam 게임 검색 오류 (${gameName}):`, error.message);
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

        const priceUrl = `${STEAM_STORE_API_BASE}/appdetails?appids=${gameInfo.appid}&cc=KR&l=korean&filters=price_overview,name`;
        
        console.log(`Steam 가격 정보 요청: ${gameName} (ID: ${gameInfo.appid})`);
        const response = await axios.get(priceUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const appData = response.data[gameInfo.appid];
        
        if (appData && appData.success && appData.data) {
            const gameData = appData.data;
            const priceOverview = gameData.price_overview;
            
            let result = {
                exactName: gameData.name || gameInfo.name,
                appid: gameInfo.appid
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
            console.log(`Steam 가격 정보 획득: ${result.exactName} - ${result.final}`);
            return result;
        }

        console.log(`Steam 가격 정보를 가져올 수 없음: ${gameName}`);
        return null;

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
    // Steam API는 한국 원화를 센트 단위로 반환하므로 100으로 나누기
    const actualPrice = Math.round(cents / 100);
    return `₩${actualPrice.toLocaleString('ko-KR')}`;
}

async function getKoreanGameName(englishName) {
    try {
        const gameInfo = await searchSteamGame(englishName);
        if (!gameInfo) {
            return ""; // 빈 문자열 반환
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
            
            // 한국어 제목이 영어와 동일하면 빈 문자열 반환
            if (koreanName === englishName) {
                return "";
            }
            
            console.log(`한국어 제목 발견: ${englishName} → ${koreanName}`);
            return koreanName;
        }

        return ""; // 한국어 제목이 없으면 빈 문자열 반환
        
    } catch (error) {
        console.error(`한국어 제목 가져오기 오류 (${englishName}):`, error.message);
        return ""; // 오류 발생시 빈 문자열 반환
    }
}

// 가격 파싱 (원화/달러 처리)
function parsePrice(priceString) {
    if (!priceString) return 0;
    
    // 무료 게임 처리
    if (priceString === "무료" || priceString.toLowerCase().includes('free')) return 0;
    
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

function sanitizeProductName(name) {
    // \ * ? " < > | : / 등의 특수문자 제거
    return name.replace(/[\\*?"<>|:/]/g, '').trim();
}

// API 엔드포인트: 가격 비교
app.post('/api/compare', async (req, res) => {
    const { url, minDifference = 5000 } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'CDKeys URL이 필요합니다.' });
    }
    
    try {
        console.log('=== 가격 비교 시작 (Steam API 사용) ===');
        console.log(`URL: ${url}`);
        console.log(`최소 차액: ${minDifference}원`);
        console.log(`시간: 2025-08-17 11:42:49 UTC`);
        console.log(`사용자: wogho`);
        
        // CDKeys 게임 목록 가져오기
        const cdkeysGames = await fetchCDKeysGames(url);
        
        if (cdkeysGames.length === 0) {
            return res.json({ 
                success: true, 
                games: [],
                message: '게임을 찾을 수 없습니다.' 
            });
        }
        
        // Steam API로 가격 비교
        const comparisons = [];
        
        for (const game of cdkeysGames) {
            try {
                const steamPrice = await fetchSteamPrice(game.name);
                
                if (steamPrice && steamPrice.final !== "무료") {
                    const cdkeysPrice = parsePrice(game.price);
                    const steamOriginalPrice = parsePrice(steamPrice.original);
                    const steamFinalPrice = parsePrice(steamPrice.final);
                    const savings = steamOriginalPrice - cdkeysPrice;
                    
                    console.log(`${game.name}: CDKeys ${cdkeysPrice}원 vs Steam ${steamOriginalPrice}원 (절약: ${savings}원)`);
                    
                    if (savings >= minDifference) {
                        comparisons.push({
                            id: game.id,
                            name: game.name,
                            exactName: game.name, // steamPrice.exactName 대신 game.name 사용
                            cdkeysPrice,
                            cdkeysUrl: game.url,
                            steamOriginalPrice,
                            steamFinalPrice,
                            steamDiscount: steamPrice.discount,
                            savings,
                            savingsPercent: Math.round((savings / steamOriginalPrice) * 100),
                            steamAppId: steamPrice.appid
                        });
                    }
                }
                
                // API 요청 간 딜레이 (Steam API 제한 준수)
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

// 엑셀 내보내기 API (wogho님 정확한 고정값 적용)
app.post('/api/export-excel', async (req, res) => {
    try {
        const { games, user = 'wogho', timestamp = new Date().toISOString() } = req.body;
        
        console.log(`\n=== 엑셀 내보내기 시작 (wogho님 정확한 고정값) ===`);
        console.log(`👤 사용자: ${user}`);
        console.log(`📅 시간: 2025-08-17 11:42:49 UTC`);
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
        // 나머지 셀을 빈 문자열로 채움 (총 80개 컬럼)
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
        
        // 각 게임별로 Steam 정보 처리 (A3부터 데이터 시작)
        for (const game of games) {
            console.log(`🔄 "${game.name}" 게임 정보 처리 중...`);
            
            try {
                const steamInfo = await getSteamGameInfo(game.name);
                const koreanName = await getKoreanGameName(game.name);
                const cleanGameName = sanitizeProductName(game.name);
                
                // 한국어 제목이 있으면 포함, 없으면 영어명만
                const productName = koreanName 
                    ? `[우회X 한국코드] ${cleanGameName} ${sanitizeProductName(koreanName)} 스팀 키`
                    : `[우회X 한국코드] ${cleanGameName} 스팀 키`;
                
                // 추가이미지: 스크린샷 4개를 개행으로 구분
                const additionalImages = steamInfo.screenshots.join('\n');
                
                // 상세설명: HTML img 태그로 구성
                const detailDescription = steamInfo.screenshots
                    .map(url => `<img src="${url}" style="opacity: 1; max-width: 803px; max-height: 550px;">`)
                    .join('\n');
                
                // wogho님 정확한 고정값으로 데이터 배열 생성 (80개 컬럼)
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
                    "", // 29. 배송비 템플릿코드 ✅ (빈칸)
                    "직접배송(화물배달)", // 30. 배송방법 ✅
                    "", // 31. 택배사코드
                    "무료", // 32. 배송비유형 ✅
                    "0", // 33. 기본배송비 ✅
                    "", // 34. 배송비 결제방식
                    "", // 35. 조건부무료- 상품판매가 합계 ✅ (빈칸)
                    "", // 36. 수량별부과-수량 ✅ (빈칸)
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
                    "", // 75. ISBN
                    "", // 76. ISSN
                    "", // 77. 독립출판
                    "", // 78. 출간일
                    "", // 79. 출판사
                ];
                
                excelData.push(row);
                console.log(`✅ "${game.name}" 게임 데이터 추가 완료 (wogho님 정확한 고정값 적용)`);
                
            } catch (error) {
                console.error(`게임 정보 처리 오류 (${game.name}):`, error.message);
                
                const basicRow = new Array(80).fill(""); // 80개 컬럼을 빈 문자열로 초기화
                basicRow[1] = "50001735"; // 카테고리코드 ✅
                basicRow[2] = `[우회X 한국코드] ${game.name} 스팀 키`; // 상품명
                basicRow[3] = "신상품"; // 상품상태 ✅
                basicRow[4] = game.sellPrice || game.cdkeysPrice; // 판매가
                basicRow[5] = "과세상품"; // 부가세 ✅
                basicRow[6] = "5"; // 재고수량 ✅
                basicRow[7] = "단독형"; // 옵션형태 ✅
                basicRow[8] = "메일주소필수기입"; // 옵션명 ✅
                basicRow[9] = game.name; // 옵션값
                basicRow[20] = "Unknown Developer"; // 브랜드
                basicRow[21] = "Unknown Developer"; // 제조사
                basicRow[24] = "03"; // 원산지코드 ✅
                basicRow[26] = "N"; // 복수원산지여부 ✅
                basicRow[27] = "상세설명에 표시"; // 원산지 직접입력 ✅
                basicRow[28] = "Y"; // 미성년자 구매 ✅
                // basicRow[29] = ""; // 배송비 템플릿코드 ✅ (빈칸)
                basicRow[30] = "직접배송(화물배달)"; // 배송방법 ✅
                basicRow[32] = "무료"; // 배송비유형 ✅
                basicRow[33] = "0"; // 기본배송비 ✅
                // basicRow[35] = ""; // 조건부무료- 상품판매가 합계 ✅ (빈칸)
                // basicRow[36] = ""; // 수량별부과-수량 ✅ (빈칸)
                basicRow[41] = "0"; // 반품배송비 ✅
                basicRow[42] = "0"; // 교환배송비 ✅
                basicRow[44] = "N"; // 별도설치비 ✅
                basicRow[50] = "3235865"; // A/S 템플릿코드 ✅
                basicRow[51] = "050714090848"; // A/S 전화번호 ✅
                basicRow[52] = "050714090848"; // A/S 안내 ✅
                basicRow[72] = "Y"; // 구매평 노출여부 ✅
                basicRow[74] = "N"; // 알림받기 동의 고객 전용 여부 ✅
                
                excelData.push(basicRow);
                console.log(`⚠️ "${game.name}" 게임 기본 데이터 추가 (wogho님 정확한 고정값)`);
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
        
        console.log(`✅ wogho님 정확한 고정값이 적용된 엑셀 파일 생성 완료: ${fileName}`);
        console.log(`📊 총 ${excelData.length}행 (A1 헤더 1행 + 컬럼 헤더 1행 + 데이터 ${excelData.length - 2}행)`);
        console.log(`🎯 2025-08-17 11:42:49 UTC - wogho님 요청사항 100% 반영 완료`);
        
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

// 관리용 엑셀 내보내기 API (wogho님 A5 판매가 -500 고정 반영)
app.post('/api/export-excel-management', async (req, res) => {
    try {
        const { games, user = 'wogho', timestamp = new Date().toISOString() } = req.body;
        
        console.log(`\n=== 관리용 엑셀 내보내기 시작 (A5 판매가 -500 고정) ===`);
        console.log(`👤 사용자: ${user}`);
        console.log(`📅 시간: 2025-08-17 12:14:31 UTC`);
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
                
                // 상품명 생성 (기존 로직과 동일)
                const productName = koreanName 
                    ? `[우회X 한국코드] ${cleanGameName} ${sanitizeProductName(koreanName)} 스팀 키`
                    : `[우회X 한국코드] ${cleanGameName} 스팀 키`;
                
                // A5 판매가 계산: 사용자 입력값 - 500원 고정
                const originalSellPrice = game.sellPrice || 0;
                const adjustedSellPrice = Math.max(0, originalSellPrice - 500); // 0보다 작아지지 않도록
                
                console.log(`💰 "${game.name}" 가격 조정: ${originalSellPrice}원 → ${adjustedSellPrice}원 (-500원)`);
                
                // 관리용 데이터 배열 (A1~A7)
                const gameData = [
                    productName,                    // A1: 상품명
                    "",                            // A2: 빈칸 (고정)
                    game.cdkeysUrl || "",          // A3: CDKeys 구매 링크
                    "0",                           // A4: 0 (고정)
                    adjustedSellPrice,             // A5: 판매가 (사용자 입력값 - 500원) ✅
                    "0",                           // A6: 0 (고정)
                    game.cdkeysPrice || 0          // A7: CDKeys 가격
                ];
                
                excelData.push(gameData);
                console.log(`✅ "${game.name}" 관리용 데이터 추가 완료 (A5: ${adjustedSellPrice}원)`);
                
            } catch (error) {
                console.error(`관리용 데이터 처리 오류 (${game.name}):`, error.message);
                
                // 오류 발생시 기본 데이터 (동일하게 -500 적용)
                const originalSellPrice = game.sellPrice || 0;
                const adjustedSellPrice = Math.max(0, originalSellPrice - 500);
                
                const basicData = [
                    `[우회X 한국코드] ${sanitizeProductName(game.name)} 스팀 키`, // A1
                    "",                            // A2
                    game.cdkeysUrl || "",          // A3
                    "0",                           // A4
                    adjustedSellPrice,             // A5: 판매가 (사용자 입력값 - 500원) ✅
                    "0",                           // A6
                    game.cdkeysPrice || 0          // A7
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
        console.log(`📊 총 ${excelData.length}행 (각 게임당 1행)`);
        console.log(`📋 컬럼: A1(상품명), A2(빈칸), A3(CDKeys링크), A4(0), A5(판매가-500), A6(0), A7(CDKeys가격)`);
        console.log(`💰 A5 판매가 정책 적용 완료: 모든 게임 -500원 차감`);
        
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
        memory: process.memoryUsage(),
        features: [
            'CDKeys Crawling',
            'Steam Price Comparison',
            'Excel Export (wogho Fixed Values)',
            'Excel Export Management',
            'Cache Management'
        ],
        user: 'wogho',
        timestamp: '2025-08-17 11:42:49 UTC',
        fixedValues: {
            카테고리코드: "50001735",
            상품상태: "신상품",
            부가세: "과세상품",
            재고수량: "5",
            옵션형태: "단독형",
            옵션명: "메일주소필수기입",
            원산지코드: "03",
            복수원산지여부: "N",
            원산지직접입력: "상세설명에 표시",
            미성년자구매: "Y",
            배송비템플릿코드: "",
            배송방법: "직접배송(화물배달)",
            배송비유형: "무료",
            기본배송비: "0",
            반품배송비: "0",
            교환배송비: "0",
            별도설치비: "N",
            AS템플릿코드: "3235865",
            AS전화번호: "050714090848",
            AS안내: "050714090848",
            구매평노출여부: "Y",
            알림받기동의고객전용여부: "N"
        }
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
    CDKeys-Steam 가격 비교 서버 + 엑셀 내보내기
    포트: ${PORT}
    URL: http://0.0.0.0:${PORT}
    외부 접속: http://140.238.30.184:${PORT}
    사용자: wogho
    시간: 2025-08-17 11:42:49 UTC
    A1 헤더: "상품 기본정보"
    고정값: wogho님 요청사항 정확히 반영
    관리용 엑셀: 추가 완료
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