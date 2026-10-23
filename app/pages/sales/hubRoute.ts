/**
 * Does a hub answer mean "this server does not have the route yet"? An unknown GET falls through to the app
 * shell (200 with HTML) and an unknown POST gets Express's 404 page; neither is JSON. A proxy's 502/503/504
 * page while the hub restarts after a deploy is not JSON either, but says nothing about the route.
 */
export function answerMeansMissingRoute({ parsed, status, method = '' }: { parsed: boolean; status: number; method?: string }) {
  if (parsed) return false;
  if (status === 404) return true;
  const isGet = !method || method.toUpperCase() === 'GET';
  return isGet && status >= 200 && status < 300;
}
