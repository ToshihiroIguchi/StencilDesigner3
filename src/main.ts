import { App } from './ui/app';
import './styles.css';

const canvas = document.getElementById('main-canvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('main-canvas element not found');
}

const app = new App(canvas);
app.init().catch(console.error);

// Expose app globally for E2E tests
(window as unknown as { __app: App }).__app = app;
