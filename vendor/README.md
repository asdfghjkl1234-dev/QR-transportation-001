# vendor/ — 第三方函式庫的本地備份

兩個頁面預設從 CDN 載入函式庫，這裡放的是**離線備份**：
CDN 連不上時（沒有網路、內網環境、CDN 被擋），頁面會自動改用這裡的檔案。
兩份都是直接從 npm 取得的未修改原始檔。

| 檔案 | 套件 | 版本 | 授權 |
|---|---|---|---|
| `qrcode-generator-1.4.4.js` | [qrcode-generator](https://www.npmjs.com/package/qrcode-generator) | 1.4.4 | MIT（Kazuhiko Arase） |
| `jsQR-1.4.0.js` | [jsQR](https://www.npmjs.com/package/jsqr) | 1.4.0 | Apache-2.0（Cosmo Wolfe） |

更新方式：

```sh
npm pack qrcode-generator@1.4.4 jsqr@1.4.0
tar xzf qrcode-generator-1.4.4.tgz && cp package/qrcode.js vendor/qrcode-generator-1.4.4.js
tar xzf jsqr-1.4.0.tgz --one-top-level=jsqr && cp jsqr/package/dist/jsQR.js vendor/jsQR-1.4.0.js
```
