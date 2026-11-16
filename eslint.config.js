import tseslint from 'typescript-eslint';

export default tseslint.config(
    {ignores: ['dist/**', 'node_modules/**', 'figma-assets/**', 'src/tools/**', 'src/protocol/**', 'src/bridge/**']},
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
        },
    },
);
