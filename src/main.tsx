import { Message } from './components/ui/Message';
import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/global.css';

const DemoApp = import.meta.env.VITE_APP_DEMO === 'true' ? lazy(() => import('./demo/DemoApp')) : null;
if (DemoApp) document.title = 'Демонстрация · Хор';
const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент приложения');
createRoot(root).render(<StrictMode><Suspense fallback={<Message tone="muted" role="status">Загрузка…</Message>}>
  {DemoApp ? <DemoApp /> : <App />}
</Suspense></StrictMode>);
