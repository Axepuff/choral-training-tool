/** Storybook previews link to the application published beside Storybook. */
export function appUrl(query: string): string {
  const url = new URL(window.location.href);
  if (url.pathname.endsWith('/iframe.html')) {
    url.pathname = url.pathname.replace(/iframe\.html$/, 'app/');
  }
  url.search = query;
  url.hash = '';
  return url.href;
}
