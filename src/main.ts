import { App } from './ui/app';
import { loadConfig } from './config';
import './styles.css';

const canvas = document.getElementById('main-canvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('main-canvas element not found');
}

// Load configuration before initializing the application
loadConfig()
  .then(() => {
    const app = new App(canvas);
    return app.init().then(() => {
      (window as unknown as { __app: App }).__app = app;
    });
  })
  .catch(console.error);

