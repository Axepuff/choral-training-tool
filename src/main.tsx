import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RehearsalPlayer } from './components/RehearsalPlayer/RehearsalPlayer';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент приложения');

createRoot(root).render(
  <StrictMode>
    <RehearsalPlayer />
  </StrictMode>,
);
