import React, { useState, useCallback } from 'react';
import { MultiEditorReact } from '@collab-editor/web/src/react/index.js';

export default function App() {
  const [events, setEvents] = useState<string[]>([]);
  const [mode, setMode] = useState<'wysiwyg' | 'source'>('wysiwyg');

  const log = useCallback((msg: string) => {
    setEvents((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()} ${msg}`]);
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui' }}>
      <h1>React + Collaborative Editor</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={() => setMode('wysiwyg')}>WYSIWYG</button>
        <button onClick={() => setMode('source')}>Source</button>
      </div>
      <MultiEditorReact
        mode={mode}
        format="markdown"
        placeholder="Start writing in React..."
        theme="light"
        collaboration={{
          enabled: true,
          roomName: 'react-demo',
          providerUrl: 'ws://localhost:8080/ws',
          user: { name: 'React User', color: '#e06c75' },
        }}
        onEditorChange={(e: any) => log(`change: ${e.detail.value.substring(0, 50)}...`)}
        onModeChange={(e: any) => {
          log(`mode: ${e.detail.previousMode} -> ${e.detail.mode}`);
          setMode(e.detail.mode);
        }}
        onEditorSave={() => log('save triggered')}
        onCollabStatus={(e: any) => log(`collab: ${e.detail.status}`)}
        style={{ border: '1px solid #ddd', borderRadius: 6, minHeight: 300 }}
      />
      <div style={{ marginTop: 16, padding: 12, background: '#f5f5f5', borderRadius: 6, maxHeight: 200, overflow: 'auto' }}>
        <h3 style={{ margin: '0 0 8px' }}>Event Log</h3>
        {events.map((e, i) => (
          <div key={i} style={{ fontSize: 12, fontFamily: 'monospace', color: '#666' }}>{e}</div>
        ))}
      </div>
    </div>
  );
}
