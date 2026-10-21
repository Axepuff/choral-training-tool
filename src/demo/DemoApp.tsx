import { RehearsalPlayer } from '../components/RehearsalPlayer/RehearsalPlayer';
import { CreateSong } from '../components/CreateSong/CreateSong';
import { SignIn } from '../components/SignIn/SignIn';
import { SongLibrary } from '../components/SongLibrary/SongLibrary';
import { mockSongs } from '../components/SongLibrary/mockSongs';
export default function DemoApp() {
  const params = new URLSearchParams(window.location.search);
  const page = params.get('page');
  const song = mockSongs.find((item) => item.id === params.get('song'));
  return <>
    {page === 'sign-in' ? <SignIn /> : page === 'library' ? <SongLibrary songs={mockSongs} /> : page === 'create-song' ? <CreateSong /> : <RehearsalPlayer pieceTitle={song?.title ?? 'Тихий вечер'} bars={song?.bars ?? 4} />}
  </>;
}
