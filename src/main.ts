import { App } from './ui/app';
import { loadConfig } from './config';
import './styles.css';

const canvas = document.getElementById('main-canvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('main-canvas element not found');
}

// 設定を読み込んでからアプリケーションを初期化する
loadConfig()
  .then(() => {
    const app = new App(canvas);
    return app.init().then(() => {
      (window as unknown as { __app: App }).__app = app;
    });
  })
  .catch(console.error);

