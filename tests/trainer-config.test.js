import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TRAINER_CONFIGS, getConfig } from '../js/trainer-config.js';

const TYPES = ['image', 'audio', 'pose'];

describe('TRAINER_CONFIGS', () => {

    it('covers exactly the three project types', () => {
        assert.deepEqual(Object.keys(TRAINER_CONFIGS).sort(), [...TYPES].sort());
    });

    it('getConfig falls back to image for anything unknown', () => {
        for (const value of [undefined, null, '', 'nope', 'constructor', 'toString']) {
            assert.equal(getConfig(value), TRAINER_CONFIGS.image, String(value));
        }
    });
});

describe('defaultClasses', () => {

    it('every project starts with at least the training minimum of classes', () => {
        // Menos clases que el mínimo dejaría un proyecto nuevo sin poder
        // entrenar aunque la docente complete todo lo que ve.
        for (const type of TYPES) {
            assert.ok(TRAINER_CONFIGS[type].defaultClasses.length >= 2, type);
        }
    });

    it('new classes are born unnamed, except a fixed first class', () => {
        for (const type of TYPES) {
            const { defaultClasses, fixedFirstClass } = TRAINER_CONFIGS[type];
            defaultClasses.forEach((name, i) => {
                if (i === 0 && fixedFirstClass) return;
                assert.equal(name, '', `${type}[${i}]`);
            });
        }
    });

    it('a fixed first class matches defaultClasses[0] exactly', () => {
        // En audio el nombre ES la clave con la que speech-commands indexa las
        // muestras: si el rótulo del input y el nombre con el que se crea la
        // clase se separan, el fallo es silencioso y cuesta las muestras.
        for (const type of TYPES) {
            const { defaultClasses, fixedFirstClass } = TRAINER_CONFIGS[type];
            if (!fixedFirstClass) continue;
            assert.equal(defaultClasses[0], fixedFirstClass, type);
        }
    });

    it('audio is the one with a fixed first class', () => {
        assert.equal(TRAINER_CONFIGS.audio.fixedFirstClass, 'Ruido de fondo');
        assert.equal(TRAINER_CONFIGS.image.fixedFirstClass, null);
        assert.equal(TRAINER_CONFIGS.pose.fixedFirstClass, null);
    });
});
