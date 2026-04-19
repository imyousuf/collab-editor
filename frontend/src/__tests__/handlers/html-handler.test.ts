import { contentHandlerContractTests } from '../interfaces/content-handler.contract.js';
import { HtmlContentHandler } from '../../handlers/html-handler.js';

contentHandlerContractTests(
  'HtmlContentHandler',
  () => new HtmlContentHandler(),
  [
    { input: '<h1>Hello</h1><p>World</p>', expectedType: 'html' },
    { input: '<ul><li>item</li></ul>', expectedType: 'html' },
    { input: '', expectedType: 'html' },
    { input: '<div class="test">content</div>', expectedType: 'html' },
  ],
);
