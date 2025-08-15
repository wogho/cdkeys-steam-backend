# CDKeys-Steam 가격 비교 시스템

실시간으로 CDKeys와 Steam의 게임 가격을 비교하여 할인 정보를 제공하는 웹 서비스입니다.

## 🚀 주요 기능

- CDKeys 게임 목록 자동 크롤링
- Steam 가격 실시간 비교
- 사용자 정의 최소 차액 설정
- 캐싱을 통한 성능 최적화
- HTTPS 보안 연결 지원

## 📋 필요 환경

- Ubuntu 22.04 ARM64
- Node.js 20.x
- Chromium Browser
- Nginx
- PM2

## 🛠 설치 방법

### 1. 저장소 클론
```bash
git clone https://github.com/yourusername/cdkeys-steam-backend.git
cd cdkeys-steam-backend
```

### 2. 의존성 설치
```bash
npm install
```

### 3. 환경 변수 설정
```bash
cp .env.example .env
nano .env
```

### 4. 서버 실행
```bash
# 개발 모드
npm start

# 프로덕션 모드 (PM2)
pm2 start server.js --name cdkeys-steam
```

## 🌐 접속 방법

- HTTP: `http://서버IP:8080`
- HTTPS: `https://서버IP:8443`

## 📁 프로젝트 구조

```
cdkeys-steam-backend/
├── server.js           # 메인 서버 파일
├── public/            
│   └── index.html     # 프론트엔드 UI
├── package.json       # 프로젝트 의존성
├── .env              # 환경 변수 (gitignore)
└── README.md         # 프로젝트 문서
```

## 🔧 API 엔드포인트

- `GET /api/status` - 서버 상태 확인
- `POST /api/compare` - 가격 비교 실행
- `DELETE /api/cache` - 캐시 초기화

## 📝 라이센스

MIT License

## 👥 기여

Pull Request와 Issue는 언제든 환영합니다!
