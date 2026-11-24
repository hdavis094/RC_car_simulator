/// <reference types="vite/client" />
import html from '../../../renderer/world/phone-controller.html?raw';
import script from '../../../renderer/world/phone-controller.js?raw';
import style from '../../../renderer/world/phone-controller.css?raw';

export const phoneAssets = new Map([
  ['/', { contentType: 'text/html; charset=utf-8', body: html }],
  ['/controller.js', { contentType: 'text/javascript; charset=utf-8', body: script }],
  ['/controller.css', { contentType: 'text/css; charset=utf-8', body: style }],
]);
