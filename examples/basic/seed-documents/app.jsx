import React, { useState, useEffect } from 'react';

function CollabStatus({ status }) {
  const colors = {
    connected: '#4caf50',
    connecting: '#ff9800',
    disconnected: '#f44336',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: colors[status] || '#999',
        }}
      />
      <span>{status}</span>
    </div>
  );
}

function DocumentList({ documents, onSelect, activeDoc }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {documents.map((doc) => (
        <li
          key={doc.id}
          onClick={() => onSelect(doc)}
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            backgroundColor: activeDoc?.id === doc.id ? '#e3f2fd' : 'transparent',
            borderRadius: 4,
          }}
        >
          {doc.name}
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const [status, setStatus] = useState('disconnected');
  const [documents] = useState([
    { id: 'welcome', name: 'Welcome Guide' },
    { id: 'notes', name: 'Meeting Notes' },
  ]);
  const [activeDoc, setActiveDoc] = useState(documents[0]);

  useEffect(() => {
    console.log(`Switched to document: ${activeDoc.name}`);
  }, [activeDoc]);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 240, borderRight: '1px solid #eee', padding: 16 }}>
        <h2>Documents</h2>
        <DocumentList
          documents={documents}
          onSelect={setActiveDoc}
          activeDoc={activeDoc}
        />
      </aside>
      <main style={{ flex: 1, padding: 16 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h1>{activeDoc.name}</h1>
          <CollabStatus status={status} />
        </header>
        {/* Editor would go here */}
        <div style={{ border: '1px solid #ddd', borderRadius: 8, minHeight: 400, padding: 16 }}>
          <p>Editor for: {activeDoc.id}</p>
        </div>
      </main>
    </div>
  );
}
