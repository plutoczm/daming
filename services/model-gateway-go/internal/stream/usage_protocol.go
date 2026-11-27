package stream

type aUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	// CacheCreation splits the cache writes by how long they are kept,
	// which Anthropic bills apart: 1.25× input for 5 minutes, 2× for an
	// hour
	CacheCreation *aCacheCreation `json:"cache_creation,omitempty"`
	// CacheUnknown: a plugin's usage saying its vendor gave no cache
	// counts (magpie_cache_unknown), so the zero above is not a miss:
	// Kiro caches but tells only credits, never tokens (zeewell on X).
	// It is read, never told: anthropic() leaves it false.
	CacheUnknown bool `json:"magpie_cache_unknown,omitempty"`
}

type aCacheCreation struct {
	Ephemeral5m int `json:"ephemeral_5m_input_tokens"`
	Ephemeral1h int `json:"ephemeral_1h_input_tokens"`
}

func (u Usage) Responses() map[string]any {
	in := u.Input + u.CacheRead + u.CacheWrite
	return map[string]any{"input_tokens": in, "output_tokens": u.Output, "total_tokens": in + u.Output,
		"input_tokens_details":  map[string]any{"cached_tokens": u.CacheRead, "cache_write_tokens": u.CacheWrite},
		"output_tokens_details": map[string]any{"reasoning_tokens": u.Reasoning}}
}

func (u Usage) Anthropic() aUsage {
	out := aUsage{InputTokens: u.Input, OutputTokens: u.Output, CacheReadInputTokens: u.CacheRead, CacheCreationInputTokens: u.CacheWrite}
	if h := min(u.CacheWrite1h, u.CacheWrite); u.cacheCreationReported || h > 0 {
		out.CacheCreation = &aCacheCreation{Ephemeral5m: u.CacheWrite - h, Ephemeral1h: h}
	}
	return out
}
