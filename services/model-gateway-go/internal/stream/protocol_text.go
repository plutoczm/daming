package stream

import (
	"strings"
	"time"
)

type TextEncoder struct {
	protocol, id, model, text string
	emit                      func(map[string]any) error
	started                   bool
}

func NewTextEncoder(protocol, id, model string, emit func(map[string]any) error) *TextEncoder {
	return &TextEncoder{protocol: protocol, id: id, model: model, emit: emit}
}
func (e *TextEncoder) send(v map[string]any) error {
	if e.emit == nil {
		return nil
	}
	return e.emit(v)
}
func (e *TextEncoder) Start() error {
	if e.started {
		return nil
	}
	e.started = true
	if e.protocol == "responses" {
		if err := e.send(map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_" + e.id, "object": "response", "status": "in_progress", "model": e.model, "output": []any{}}}); err != nil {
			return err
		}
		if err := e.send(map[string]any{"type": "response.output_item.added", "response_id": "resp_" + e.id, "output_index": 0, "item": map[string]any{"id": "msg_" + e.id, "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}}); err != nil {
			return err
		}
		return e.send(map[string]any{"type": "response.content_part.added", "response_id": "resp_" + e.id, "item_id": "msg_" + e.id, "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
	}
	if err := e.send(map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_" + e.id, "type": "message", "role": "assistant", "model": e.model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 0, "output_tokens": 0}}}); err != nil {
		return err
	}
	return e.send(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
}
func (e *TextEncoder) Delta(text string) error {
	e.text += text
	if e.protocol == "responses" {
		return e.send(map[string]any{"type": "response.output_text.delta", "response_id": "resp_" + e.id, "item_id": "msg_" + e.id, "output_index": 0, "content_index": 0, "delta": text})
	}
	return e.send(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": text}})
}
func (e *TextEncoder) End(usage *Usage, stop string, complete bool) error {
	if !complete {
		return e.send(map[string]any{"type": "error", "error": map[string]string{"type": "upstream_incomplete", "message": "Model response did not complete reliably"}})
	}
	// Text-only branches adapted from Magpie renderResponses/renderAnthropic.
	if e.protocol == "responses" {
		status, event := "completed", "response.completed"
		var incomplete any
		if stop == "length" {
			status, event = "incomplete", "response.incomplete"
			incomplete = map[string]string{"reason": "max_output_tokens"}
		}
		part := map[string]any{"type": "output_text", "text": e.text, "annotations": []any{}}
		item := map[string]any{"id": "msg_" + e.id, "type": "message", "role": "assistant", "status": status, "content": []any{part}}
		for _, v := range []map[string]any{
			{"type": "response.output_text.done", "response_id": "resp_" + e.id, "item_id": "msg_" + e.id, "output_index": 0, "content_index": 0, "text": e.text},
			{"type": "response.content_part.done", "response_id": "resp_" + e.id, "item_id": "msg_" + e.id, "output_index": 0, "content_index": 0, "part": part},
			{"type": "response.output_item.done", "response_id": "resp_" + e.id, "output_index": 0, "item": item},
		} {
			if err := e.send(v); err != nil {
				return err
			}
		}
		var u any
		if usage != nil {
			u = usage.Responses()
		}
		return e.send(map[string]any{"type": event, "response": map[string]any{"id": "resp_" + e.id, "object": "response", "created_at": time.Now().Unix(), "status": status, "model": e.model, "output": []any{item}, "usage": u, "incomplete_details": incomplete, "error": nil}})
	}
	if err := e.send(map[string]any{"type": "content_block_stop", "index": 0}); err != nil {
		return err
	}
	reason := "end_turn"
	if strings.EqualFold(stop, "length") {
		reason = "max_tokens"
	}
	value := map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}}
	if usage != nil {
		value["usage"] = usage.Anthropic()
	}
	if err := e.send(value); err != nil {
		return err
	}
	return e.send(map[string]any{"type": "message_stop"})
}
