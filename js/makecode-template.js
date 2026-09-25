/**
 * makecode-template.js
 * Pure generators for the files of the MakeCode project the app builds: the
 * class enum (tm-classes.ts) and the starter program, which ships as both
 * TypeScript (main.ts) and Blockly XML (main.blocks).
 *
 * No browser APIs: importable from node:test. All three generators derive
 * enum identifiers through the same helper, so every TMClase.<id> referenced
 * in main.ts or main.blocks is guaranteed to exist in tm-classes.ts.
 */

import { deriveEnumIdentifiers, stripUnsafeChars } from './class-name.js';

// Default threshold of the starter blocks. Matches `umbral.defl=80` of the
// alDetectarClase block in pxt-tm-microbit-link-v2.
export const STARTER_THRESHOLD = 80;

// Content of main.ts when there are no classes to build blocks for.
export const EMPTY_MAIN_TS = '// Programá tu micro:bit acá\n';

// Namespace MakeCode itself writes into main.blocks.
const BLOCKS_XML_NS = 'https://developers.google.com/blockly/xml';

// main.blocks with no blocks. NOT the empty string: pxt forces the JavaScript
// editor when main.blocks has no content (see generateStarterMainBlocks).
export const EMPTY_MAIN_BLOCKS = `<xml xmlns="${BLOCKS_XML_NS}"><variables></variables></xml>`;

// Where the starter blocks sit in the workspace, in Blockly units.
//
// An "al detectar" block with an empty body is about 100 units tall, so a
// spacing of 100 left them touching, with no gap between one block's closing
// bar and the next one's header: the spacing has to clear the block's own
// height with room to spare. The same order of magnitude MakeCode itself
// writes when it saves a workspace (in tests/fixtures/projects-v1.json, x
// between 103 and 203 and vertical gaps of 167 and 289 — it does not align
// blocks in a single column, this generator does).
//
// x only indents the column off the toolbox edge, and stays small on purpose:
// the block is ~275 px wide with its threshold slider, so a deeper indent
// pushes its right edge off a phone-width panel.
const STARTER_BLOCK_X = 80;
const STARTER_BLOCK_FIRST_Y = 40;
const STARTER_BLOCK_SPACING_Y = 160;

/**
 * Safe names and their enum identifiers, index-aligned with classNames.
 *
 * Names go through stripUnsafeChars() before anything else: defence in
 * depth, a no-op for well-formed input, the same guard formatUartMessage()
 * applies at its own point of use. JSON.stringify() escapes quotes and
 * backslashes but NOT U+2028/U+2029, which are line terminators in the
 * ECMAScript grammar.
 *
 * Class names are not normalized at the rehydration boundary on purpose
 * (it would orphan the samples of an audio project, where the name is the
 * key the recognizer indexes them by), so each point of use guards itself.
 */
function classEntries(classNames) {
    const safeNames = classNames.map(stripUnsafeChars);
    const identifiers = deriveEnumIdentifiers(safeNames);
    return safeNames.map((name, i) => ({ name, identifier: identifiers[i] }));
}

/**
 * tm-classes.ts: the TMClase enum, the _tmClaseNombres array the extension
 * compares incoming UART names against, and the hidden picker block.
 * @param {string[]} classNames
 * @returns {string}
 */
export function generateTmClassesTs(classNames) {
    const entries = classEntries(classNames);
    const enumMembers = entries.map(({ name, identifier }, i) => {
        return `    //% block=${JSON.stringify(name)}\n    ${identifier} = ${i}`;
    });
    const arrayItems = entries.map(({ name }) => JSON.stringify(name)).join(', ');
    return `enum TMClase {\n${enumMembers.join(',\n')}\n}\nnamespace iaMachine {\n    export const _tmClaseNombres = [${arrayItems}];\n    //% blockId=tm_clase_picker\n    //% block="$clase"\n    //% blockHidden=true\n    //% shim=TD_ID\n    export function tmClasePicker(clase: TMClase): number {\n        return clase;\n    }\n}\n`;
}

/**
 * main.blocks for a brand-new project: one empty "al detectar <clase>" block
 * per class, in class order, already laid out in the workspace.
 *
 * This file has to carry the blocks as XML rather than be left empty for
 * MakeCode to decompile main.ts into, because pxt forces the JavaScript
 * editor when main.blocks has no content, before it ever looks at
 * `preferredEditor` (webapp/src/app.tsx, loadHeaderAsync):
 *
 *     if (pxteditor.isBlocks(file) && !file.content) {
 *         // empty blocks file, open javascript editor
 *
 * So "empty main.blocks" and "open in blocks" are mutually exclusive, and no
 * pxt.json field changes that. generateStarterMainTs() produces the matching
 * TypeScript for main.ts: the two must stay equivalent.
 *
 * The block id, the shadow ids and the threshold range are those of
 * `alDetectarClase` in the pinned commit of pxt-tm-microbit-link-v2
 * (`ia_on_class_threshold`, `clase.shadow="tm_clase_picker"`,
 * `umbral.min=0 umbral.max=100 umbral.defl=80`). Re-pinning the extension
 * means re-checking them.
 *
 * Nothing here needs XML escaping: the only interpolated value is an
 * identifier from deriveEnumIdentifiers(), which is [A-Za-z0-9_] by
 * construction, and the threshold, which is a number constant.
 *
 * @param {string[]} classNames
 * @returns {string}
 */
export function generateStarterMainBlocks(classNames) {
    const entries = classEntries(classNames);
    if (entries.length === 0) return EMPTY_MAIN_BLOCKS;
    const blocks = entries.map(({ identifier }, i) => {
        const y = STARTER_BLOCK_FIRST_Y + i * STARTER_BLOCK_SPACING_Y;
        return `<block type="ia_on_class_threshold" x="${STARTER_BLOCK_X}" y="${y}">`
            + '<value name="clase">'
            + `<shadow type="tm_clase_picker"><field name="clase">TMClase.${identifier}</field></shadow>`
            + '</value>'
            + '<value name="umbral">'
            + '<shadow type="math_number_minmax">'
            + '<mutation min="0" max="100" label="Umbral" precision="0"></mutation>'
            + `<field name="SLIDER">${STARTER_THRESHOLD}</field>`
            + '</shadow>'
            + '</value>'
            + '</block>';
    }).join('');
    return `<xml xmlns="${BLOCKS_XML_NS}"><variables></variables>${blocks}</xml>`;
}

/**
 * main.ts for a brand-new project: one empty "al detectar <clase>" handler
 * per class, in class order. The call shape is the one MakeCode itself emits
 * for that block, so it is the TypeScript equivalent of what
 * generateStarterMainBlocks() writes into main.blocks. The two ship together
 * and have to stay equivalent; a test ties them to the same identifiers.
 * @param {string[]} classNames
 * @returns {string}
 */
export function generateStarterMainTs(classNames) {
    const entries = classEntries(classNames);
    if (entries.length === 0) return EMPTY_MAIN_TS;
    return entries.map(({ identifier }) =>
        `iaMachine.alDetectarClase(TMClase.${identifier}, ${STARTER_THRESHOLD}, function () {\n\n})\n`
    ).join('');
}
