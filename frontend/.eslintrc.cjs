module.exports = {
  root: true,
  env: { browser: true, es2021: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'eslint-config-prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  settings: { react: { version: 'detect' } },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    // react-three-fiber extends JSX with Three.js intrinsic elements (<mesh>,
    // <bufferGeometry>, ...) and non-DOM props (args, attach, intensity, ...)
    // that this rule doesn't know about — every one of them reads as a false
    // positive across the whole canvas/ tree.
    'react/no-unknown-property': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
}
