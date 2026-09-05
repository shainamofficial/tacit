/**
 * no-llm-sdk-outside-gateway
 *
 * Reports any import / re-export / dynamic import / require of a forbidden
 * module. The root eslint.config.js supplies the forbidden list per path so
 * that raw LLM SDKs are only importable from packages/gateway and the Agent
 * SDK only from packages/agents (CLAUDE.md non-negotiables #3 and #4, F-CMP-3).
 *
 * Patterns: an exact package name matches itself and any subpath
 * ("openai", "openai/helpers"); a trailing "/*" matches a whole scope
 * ("@ai-sdk/*").
 */

/**
 * @param {string} source
 * @param {string} pattern
 */
export function matches(source, pattern) {
  if (pattern.endsWith('/*')) {
    return source.startsWith(pattern.slice(0, -1));
  }
  return source === pattern || source.startsWith(`${pattern}/`);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'All model calls go through @tacit/gateway; LLM SDK imports elsewhere are forbidden (F-CMP-3).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          forbid: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "Direct import of '{{source}}' is forbidden here (matched '{{pattern}}'). " +
        'All model calls go through @tacit/gateway — CLAUDE.md non-negotiable #3, F-CMP-3.',
    },
  },

  create(context) {
    /** @type {string[]} */
    const forbid = (context.options[0] && context.options[0].forbid) || [];

    /**
     * @param {import('estree').Node} node
     * @param {unknown} source
     */
    function check(node, source) {
      if (typeof source !== 'string') return;
      const pattern = forbid.find((p) => matches(source, p));
      if (pattern) {
        context.report({ node, messageId: 'forbidden', data: { source, pattern } });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node.source, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node.source, node.source.value);
      },
      CallExpression(node) {
        const [arg] = node.arguments;
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          arg &&
          arg.type === 'Literal'
        ) {
          check(arg, arg.value);
        }
      },
    };
  },
};

export default rule;
