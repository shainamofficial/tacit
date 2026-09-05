import noLlmSdkOutsideGateway from './rules/no-llm-sdk-outside-gateway.js';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: '@tacit/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-llm-sdk-outside-gateway': noLlmSdkOutsideGateway,
  },
};

export default plugin;
