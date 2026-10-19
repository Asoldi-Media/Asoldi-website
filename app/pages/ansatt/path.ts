export const BOOKER_PATH = '/møte-booker';
export const RINGESYSTEM_HREF = 'https://asoldi.myphoner.com/work';

export function isBookerPath(pathname = '') {
  try {
    return /^\/(ansatt|møte-booker|mote-booker)(\/|$)/.test(decodeURIComponent(pathname));
  } catch {
    return /^\/(ansatt|mote-booker)(\/|$)/.test(pathname);
  }
}
