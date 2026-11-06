/* 部署後把這兩個值換成你自己的（都是可公開的值，不是密鑰） */
window.APP_CONFIG = {
  // GAS 網頁應用程式部署後的網址（結尾是 /exec）
  API_URL: 'PASTE_GAS_WEB_APP_URL_HERE',
  // Google Cloud Console 建立的 OAuth 用戶端 ID（結尾是 .apps.googleusercontent.com）
  GOOGLE_CLIENT_ID: 'PASTE_GOOGLE_CLIENT_ID_HERE',

  THRESHOLD_JPY: 5000,   // 同店同日未稅滿 5,000 日圓才可退稅
  DEADLINE_DAYS: 90,     // 購買日起 90 天內要出境
  FALLBACK_RATE: 0.21    // 抓不到匯率時的暫用值（畫面會標示「預設」）
};
