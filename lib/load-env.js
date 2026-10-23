/**
 * Loads .env before anything else is evaluated (imported first by lib/safe-mode-boot.js),
 * so data/storage-path.js sees APP_DATA_DIR from .env and safe mode sees HUB_SAFE_MODE.
 * dotenv never overrides variables that are already set (Hostinger panel values win).
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
