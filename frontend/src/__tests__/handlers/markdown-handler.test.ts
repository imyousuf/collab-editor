import { contentHandlerContractTests } from '../interfaces/content-handler.contract.js';
import { MarkdownContentHandler } from '../../handlers/markdown-handler.js';

contentHandlerContractTests(
  'MarkdownContentHandler',
  () => new MarkdownContentHandler(),
  [
    { input: '# Hello\n\nWorld **bold** text', expectedType: 'markdown' },
    { input: '- item 1\n- item 2', expectedType: 'markdown' },
    { input: '', expectedType: 'markdown' },
    { input: '```python\nprint("hi")\n```', expectedType: 'markdown' },
  ],
);
