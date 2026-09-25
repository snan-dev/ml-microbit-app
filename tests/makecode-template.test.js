import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    STARTER_THRESHOLD,
    EMPTY_MAIN_TS,
    generateTmClassesTs,
    generateStarterMainTs,
    generateStarterMainBlocks,
    EMPTY_MAIN_BLOCKS
} from '../js/makecode-template.js';

// Enum member identifiers declared in a generated tm-classes.ts, in order.
function enumMembers(tmClassesTs) {
    return [...tmClassesTs.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*) = \d+,?$/gm)].map(m => m[1]);
}

// TMClase.<id> references in a generated main.ts, in order.
function referencedMembers(mainTs) {
    return [...mainTs.matchAll(/TMClase\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
}

describe('generateTmClassesTs', () => {

    it('produces the exact file for a simple model', () => {
        // Snapshot of the output before the generator moved out of
        // makecode-embed.js: the move must not change a single byte.
        const expected =
            'enum TMClase {\n' +
            '    //% block="Gato"\n' +
            '    Gato = 0,\n' +
            '    //% block="Perro"\n' +
            '    Perro = 1\n' +
            '}\n' +
            'namespace iaMachine {\n' +
            '    export const _tmClaseNombres = ["Gato", "Perro"];\n' +
            '    //% blockId=tm_clase_picker\n' +
            '    //% block="$clase"\n' +
            '    //% blockHidden=true\n' +
            '    //% shim=TD_ID\n' +
            '    export function tmClasePicker(clase: TMClase): number {\n' +
            '        return clase;\n' +
            '    }\n' +
            '}\n';
        assert.equal(generateTmClassesTs(['Gato', 'Perro']), expected);
    });

    it('strips unsafe characters from names in the array', () => {
        // U+2028 is a line terminator JSON.stringify() does not escape.
        const ts = generateTmClassesTs(['a b']);
        assert.ok(ts.includes('_tmClaseNombres = ["a b"]'));
    });

    it('derives identifiers from the sanitized names, not the raw ones', () => {
        // 'a#b' gives Ab once sanitized but A_b raw. The identifier is what a
        // saved main.ts references, so changing the derivation would silently
        // break the blocks of existing projects.
        const ts = generateTmClassesTs(['a#b']);
        assert.ok(ts.includes('\n    Ab = 0\n'));
    });

    it('reproduces the tm-classes.ts of every project in the v1 fixture', () => {
        // Real records from the deployed site: production output, not a
        // hand-written snapshot.
        const path = fileURLToPath(new URL('./fixtures/projects-v1.json', import.meta.url));
        const projects = JSON.parse(readFileSync(path, 'utf8'));
        assert.ok(projects.length > 0);
        for (const project of projects) {
            assert.equal(
                generateTmClassesTs(project.classNames),
                project.makecodeProject.text['tm-classes.ts'],
                `project ${project.id} (${project.projectType})`
            );
        }
    });
});

describe('generateStarterMainTs', () => {

    it('produces one empty handler per class, in class order', () => {
        const expected =
            'iaMachine.alDetectarClase(TMClase.Gato, 80, function () {\n' +
            '\n' +
            '})\n' +
            'iaMachine.alDetectarClase(TMClase.Perro, 80, function () {\n' +
            '\n' +
            '})\n';
        assert.equal(generateStarterMainTs(['Gato', 'Perro']), expected);
    });

    it('uses the default threshold of the extension block', () => {
        assert.equal(STARTER_THRESHOLD, 80);
    });

    it('returns the placeholder comment when there are no classes', () => {
        assert.equal(generateStarterMainTs([]), EMPTY_MAIN_TS);
    });

    it('references exactly the identifiers declared in tm-classes.ts', () => {
        // Names chosen to exercise every derivation path: accent
        // transliteration, colliding identifiers, leading digit, unsafe
        // characters, and a name that sanitizes to nothing.
        const names = ['Señal', 'a b', 'a-b', '1uno', 'Gato "grande"', '###', 'Ruido de fondo'];
        const declared = enumMembers(generateTmClassesTs(names));
        const referenced = referencedMembers(generateStarterMainTs(names));
        assert.equal(declared.length, names.length);
        assert.deepEqual(referenced, declared);
    });
});

// TMClase.<id> references inside a generated main.blocks, in order.
function blockFieldMembers(mainBlocks) {
    return [...mainBlocks.matchAll(/<field name="clase">TMClase\.([A-Za-z_][A-Za-z0-9_]*)<\/field>/g)]
        .map(m => m[1]);
}

describe('generateStarterMainBlocks', () => {

    it('produces one block per class, in class order', () => {
        const xml = generateStarterMainBlocks(['Gato', 'Perro']);
        const expected =
            '<xml xmlns="https://developers.google.com/blockly/xml"><variables></variables>'
            + '<block type="ia_on_class_threshold" x="80" y="40">'
            + '<value name="clase">'
            + '<shadow type="tm_clase_picker"><field name="clase">TMClase.Gato</field></shadow>'
            + '</value>'
            + '<value name="umbral">'
            + '<shadow type="math_number_minmax">'
            + '<mutation min="0" max="100" label="Umbral" precision="0"></mutation>'
            + '<field name="SLIDER">80</field>'
            + '</shadow>'
            + '</value>'
            + '</block>'
            + '<block type="ia_on_class_threshold" x="80" y="200">'
            + '<value name="clase">'
            + '<shadow type="tm_clase_picker"><field name="clase">TMClase.Perro</field></shadow>'
            + '</value>'
            + '<value name="umbral">'
            + '<shadow type="math_number_minmax">'
            + '<mutation min="0" max="100" label="Umbral" precision="0"></mutation>'
            + '<field name="SLIDER">80</field>'
            + '</shadow>'
            + '</value>'
            + '</block>'
            + '</xml>';
        assert.equal(xml, expected);
    });

    // Un main.blocks sin contenido hace que pxt abra el editor de JavaScript
    // antes de mirar preferredEditor: el bug que este generador vino a cerrar.
    it('is never empty, not even without classes', () => {
        for (const names of [[], ['Gato'], ['Gato', 'Perro']]) {
            const xml = generateStarterMainBlocks(names);
            assert.ok(xml.length > 0, JSON.stringify(names));
            assert.ok(xml.startsWith('<xml '), JSON.stringify(names));
        }
        assert.equal(generateStarterMainBlocks([]), EMPTY_MAIN_BLOCKS);
    });

    it('uses the block id and shadows of the pinned extension', () => {
        // Los ids salen de alDetectarClase en pxt-tm-microbit-link-v2: si se
        // repinea la extensión hay que volver a verificarlos.
        const xml = generateStarterMainBlocks(['Gato']);
        assert.ok(xml.includes('type="ia_on_class_threshold"'));
        assert.ok(xml.includes('type="tm_clase_picker"'));
        assert.ok(xml.includes('type="math_number_minmax"'));
        assert.ok(xml.includes(`<field name="SLIDER">${STARTER_THRESHOLD}</field>`));
    });

    // Un bloque "al detectar" con cuerpo vacío mide cerca de 100 unidades:
    // con 100 de separación quedaban pegados, sin espacio entre la barra de
    // cierre de uno y el encabezado del siguiente. La separación tiene que
    // superar el alto del bloque, no solo crecer.
    it('leaves a visible gap between blocks', () => {
        const MIN_GAP = 150;
        const xml = generateStarterMainBlocks(['A', 'B', 'C']);
        const ys = [...xml.matchAll(/ y="(\d+)"/g)].map(m => Number(m[1]));
        assert.equal(ys.length, 3);
        for (let i = 1; i < ys.length; i++) {
            assert.ok(ys[i] - ys[i - 1] >= MIN_GAP, `gap ${i}: ${ys[i] - ys[i - 1]}`);
        }
        // Y ninguno arranca pegado al borde del área de trabajo.
        const xs = [...xml.matchAll(/ x="(\d+)"/g)].map(m => Number(m[1]));
        assert.equal(xs.length, 3, 'un x por bloque');
        assert.equal(new Set(xs).size, 1, 'todos alineados en la misma columna');
        assert.ok(xs[0] >= 40, `x=${xs[0]}`);
        assert.ok(ys[0] >= 20, `y inicial=${ys[0]}`);
    });

    it('references exactly the identifiers declared in tm-classes.ts', () => {
        const names = ['Señal', 'a b', 'a-b', '1uno', 'Gato "grande"', '###', 'Ruido de fondo'];
        const declared = enumMembers(generateTmClassesTs(names));
        assert.deepEqual(blockFieldMembers(generateStarterMainBlocks(names)), declared);
    });

    // main.blocks y main.ts viajan juntos en el mismo proyecto: si
    // describieran programas distintos, MakeCode mostraría una cosa y
    // compilaría otra.
    it('agrees with generateStarterMainTs on every class', () => {
        const names = ['Señal', 'a b', '1uno', '###', 'Ruido de fondo'];
        assert.deepEqual(
            blockFieldMembers(generateStarterMainBlocks(names)),
            referencedMembers(generateStarterMainTs(names))
        );
    });

    it('needs no XML escaping: identifiers cannot carry metacharacters', () => {
        const xml = generateStarterMainBlocks(['<script>', 'a&b', 'a"b', "a'b"]);
        const fields = blockFieldMembers(xml);
        assert.equal(fields.length, 4);
        for (const id of fields) assert.match(id, /^[A-Za-z0-9_]+$/);
    });
});
