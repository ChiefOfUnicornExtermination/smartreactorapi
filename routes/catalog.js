const express = require('express');

const router = express.Router();

const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = ['en', 'ja', 'es', 'fr', 'de', 'zh-TW', 'ko'];

const PRODUCT_CATALOG = {
  penlightwaver: {
    id: 'penlightwaver',
    type: 'smart-light',
    capabilities: {
      rgbColors: ['red', 'green', 'blue', 'white', 'yellow', 'cyan', 'purple'],
      brightness: { minimum: 0, maximum: 255, default: 200 },
      motorSpeedPercent: { minimum: 1, maximum: 100, default: 100 },
      maximumWaveDurationSeconds: 3600
    },
    localized: {
      en: {
        name: 'Penlight Waver',
        summary: 'A WiFi-connected RGB light and motion device for nearby desktop or performance use.',
        description: 'Penlight Waver combines a colour-changing RGB light with a controllable motor. Use it from the web dashboard or API to create a timed wave with your chosen colour, brightness, and motor speed.',
        features: ['WiFi-connected control', 'Seven RGB colours', 'Adjustable brightness', 'Adjustable motor speed', 'Timed wave mode']
      },
      ja: {
        name: 'Penlight Waver',
        summary: 'デスク周辺やパフォーマーの近くで使える、WiFi接続対応のRGBライト・モーションデバイスです。',
        description: 'Penlight Waverは、色を変えられるRGBライトと制御可能なモーターを組み合わせた製品です。WebダッシュボードまたはAPIから、色、明るさ、モーター速度、実行時間を指定したウェーブを実行できます。',
        features: ['WiFi接続による操作', '7色のRGBカラー', '明るさ調整', 'モーター速度調整', '時間指定ウェーブモード']
      },
      es: {
        name: 'Penlight Waver',
        summary: 'Un dispositivo de luz RGB y movimiento conectado por WiFi para usar cerca de un escritorio o intérprete.',
        description: 'Penlight Waver combina una luz RGB que cambia de color con un motor controlable. Usa el panel web o la API para crear una onda temporizada con el color, brillo y velocidad del motor elegidos.',
        features: ['Control por WiFi', 'Siete colores RGB', 'Brillo ajustable', 'Velocidad de motor ajustable', 'Modo de onda temporizada']
      },
      fr: {
        name: 'Penlight Waver',
        summary: 'Un appareil lumineux RGB et mobile connecté au WiFi, conçu pour être utilisé près d’un bureau ou d’un artiste.',
        description: 'Penlight Waver associe une lumière RGB à changement de couleur et un moteur contrôlable. Utilisez le tableau de bord Web ou l’API pour créer une animation temporisée avec la couleur, la luminosité et la vitesse de moteur choisies.',
        features: ['Contrôle par WiFi', 'Sept couleurs RGB', 'Luminosité réglable', 'Vitesse du moteur réglable', 'Mode animation temporisée']
      },
      de: {
        name: 'Penlight Waver',
        summary: 'Ein WLAN-fähiges RGB-Licht- und Bewegungsgerät für den Einsatz nahe einem Schreibtisch oder Darsteller.',
        description: 'Penlight Waver kombiniert ein farbwechselndes RGB-Licht mit einem steuerbaren Motor. Mit dem Web-Dashboard oder der API erstellen Sie eine zeitgesteuerte Bewegung mit gewünschter Farbe, Helligkeit und Motorgeschwindigkeit.',
        features: ['WLAN-Steuerung', 'Sieben RGB-Farben', 'Einstellbare Helligkeit', 'Einstellbare Motorgeschwindigkeit', 'Zeitgesteuerter Bewegungsmodus']
      },
      'zh-TW': {
        name: 'Penlight Waver',
        summary: '適合放在桌面或表演者附近使用的 WiFi 連線 RGB 燈光與動作裝置。',
        description: 'Penlight Waver 結合可變色的 RGB 燈光與可控制的馬達。您可以透過網頁儀表板或 API，以指定的顏色、亮度、馬達速度與時間執行定時揮動。',
        features: ['WiFi 連線控制', '七種 RGB 顏色', '可調整亮度', '可調整馬達速度', '定時揮動模式']
      },
      ko: {
        name: 'Penlight Waver',
        summary: '책상 또는 공연자 가까이에서 사용할 수 있는 WiFi 연결 RGB 조명 및 모션 장치입니다.',
        description: 'Penlight Waver는 색상이 변하는 RGB 조명과 제어 가능한 모터를 결합합니다. 웹 대시보드 또는 API에서 색상, 밝기, 모터 속도 및 시간을 지정하여 타이머 웨이브를 실행할 수 있습니다.',
        features: ['WiFi 연결 제어', '7가지 RGB 색상', '밝기 조절', '모터 속도 조절', '타이머 웨이브 모드']
      }
    }
  }
};

function selectLanguage(requestedLanguage) {
  if (!requestedLanguage) return DEFAULT_LANGUAGE;
  const requested = requestedLanguage.trim();
  if (SUPPORTED_LANGUAGES.includes(requested)) return requested;

  const baseLanguage = requested.split('-')[0].toLowerCase();
  if (SUPPORTED_LANGUAGES.includes(baseLanguage)) return baseLanguage;
  if (baseLanguage === 'zh') return 'zh-TW';
  return DEFAULT_LANGUAGE;
}

function requestedLanguage(req) {
  if (typeof req.query.lang === 'string') return req.query.lang;
  const acceptLanguage = req.get('accept-language');
  return acceptLanguage ? acceptLanguage.split(',')[0] : '';
}

function catalogProduct(product, language) {
  return {
    id: product.id,
    type: product.type,
    ...product.localized[language],
    capabilities: product.capabilities
  };
}

// GET /catalog?lang=ja
router.get('/', (req, res) => {
  const language = selectLanguage(requestedLanguage(req));
  res.json({
    language,
    fallbackLanguage: DEFAULT_LANGUAGE,
    products: Object.values(PRODUCT_CATALOG).map(product => catalogProduct(product, language))
  });
});

// GET /catalog/penlightwaver?lang=ja
router.get('/:productId', (req, res) => {
  const product = PRODUCT_CATALOG[req.params.productId];
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const language = selectLanguage(requestedLanguage(req));
  res.json({
    language,
    fallbackLanguage: DEFAULT_LANGUAGE,
    product: catalogProduct(product, language)
  });
});

module.exports = router;
