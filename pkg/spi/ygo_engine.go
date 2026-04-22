package spi

import "github.com/reearth/ygo/crdt"

// ygoEngine implements YDocEngine using reearth/ygo.
type ygoEngine struct {
	doc *crdt.Doc
}

// NewYgoEngine creates a YDocEngine backed by reearth/ygo.
func NewYgoEngine() YDocEngine {
	return &ygoEngine{doc: crdt.New()}
}

func (e *ygoEngine) ApplyUpdate(update []byte) error {
	return e.doc.ApplyUpdate(update)
}

func (e *ygoEngine) GetText(name string) string {
	return e.doc.GetText(name).ToString()
}

func (e *ygoEngine) InsertText(name string, content string) {
	text := e.doc.GetText(name)
	e.doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, content, nil)
	})
}

func (e *ygoEngine) EncodeStateAsUpdate() []byte {
	return e.doc.EncodeStateAsUpdate()
}
