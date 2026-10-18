// zip / winmail.dat unpacking lives in the shared suite core (packages/suite/core/mail/unpack.js).
import { expandContainerFiles as coreExpand } from '../../packages/suite/core/mail/unpack.js';

export { isZipFile, isTnefFile, isContainerFile, parseTnef } from '../../packages/suite/core/mail/unpack.js';

export function expandContainerFiles(files = [], options = {}) {
  return coreExpand(files, { bodyFileName: 'e-posttekst.txt', ...options });
}
