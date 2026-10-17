import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RehearsalPlayer } from './components/RehearsalPlayer/RehearsalPlayer';
import { CreateSong } from './components/CreateSong/CreateSong';
import { SignIn } from './components/SignIn/SignIn';
import { SongLibrary } from './components/SongLibrary/SongLibrary';
import { mockSongs } from './components/SongLibrary/mockSongs';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент приложения');

const params = new URLSearchParams(window.location.search);
const page = params.get('page');
const song = mockSongs.find((item) => item.id === params.get('song'));


createRoot(root).render(
  <StrictMode>
    {page === 'sign-in' ? <SignIn /> : page === 'library' ? <SongLibrary /> : page === 'create-song' ? <CreateSong /> : <RehearsalPlayer pieceTitle={song?.title ?? 'Тихий вечер'} bars={song?.bars ?? 4} />}
  </StrictMode>,
);
