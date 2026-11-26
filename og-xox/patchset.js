// OG-XOX patch sets. PATCH_SETS lists them for the installer; PATCH_SET is the
// default. They're generated into ./patches/ by firmware/build.py.
//
// Offsets are file offsets in SP404MKII_APP1.bin. For code and constants in
// SDRAM: offset = address − 0x80000000 + 0x21ac0 (see docs/spike.md).

import OGXOX from './patches/ogxox-0.11.js?v=a1226b366e';

export { BASE_552 } from './base.js?v=8fe23f95ad';

export const PATCH_SETS = [OGXOX];
export const PATCH_SET = OGXOX;
