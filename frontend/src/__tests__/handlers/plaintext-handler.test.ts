import { contentHandlerContractTests } from '../interfaces/content-handler.contract.js';
import { PlainTextContentHandler } from '../../handlers/plaintext-handler.js';

contentHandlerContractTests(
  'PlainTextContentHandler',
  () => new PlainTextContentHandler(),
  [
    { input: 'def hello():\n    print("hi")', expectedType: 'text' },
    { input: 'import React from "react";', expectedType: 'text' },
    { input: '', expectedType: 'text' },
    { input: '{"key": "value"}', expectedType: 'text' },
    { input: 'body { color: red; }', expectedType: 'text' },
  ],
);
