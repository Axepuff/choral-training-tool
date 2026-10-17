import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RehearsalPlayer } from './components/RehearsalPlayer/RehearsalPlayer';
import { CreateSong } from './components/CreateSong/CreateSong';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент приложения');

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('page') === 'create-song' ? <CreateSong /> : <RehearsalPlayer />}
  </StrictMode>,
);
