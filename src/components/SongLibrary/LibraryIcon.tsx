export function LibraryIcon({ name }: { name: 'add' | 'link' | 'edit' | 'search' | 'private' }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'add' && <path d="M12 5v14M5 12h14" />}
    {name === 'link' && <><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)" /></>}
    {name === 'edit' && <><path d="m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14l-1 7Z" /></>}
    {name === 'search' && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>}
    {name === 'private' && <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>}
  </svg>;
}
