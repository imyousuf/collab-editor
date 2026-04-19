import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

export const codeBlockLowlight = CodeBlockLowlight.configure({
  lowlight,
});

export { lowlight };
