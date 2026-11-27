package stream

type Usage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cache_read"`
	CacheWrite int `json:"cache_write"`
	// CacheWrite1h is how many of the CacheWrite tokens were written to
	// be kept for an hour, which Anthropic bills at 2× input where a
	// 5-minute write is 1.25×, when its usage says so (cache_creation's
	// ephemeral_1h_input_tokens)
	CacheWrite1h int `json:"cache_write_1h,omitempty"`
	// cacheCreationReported distinguishes a reported zero or pure-5m split
	// from usage that did not report TTLs. It is wire evidence, not a counter.
	cacheCreationReported bool
	// cacheCreationHasCounts describes the parsed update's own split.
	// It is never accumulated from earlier usage.
	cacheCreationHasCounts bool
	// cacheUnknown: the reply said its vendor counts no cache tokens
	// (a plugin's magpie_cache_unknown), so a CacheRead of 0 is not a miss
	cacheUnknown bool
	// searches: the web searches the reply says its model ran with its
	// provider's own tool (searchTally), for the request log's Web search
	// rows; told nowhere else
	searches int

	Reasoning int `json:"reasoning"`
	// Served: the model the vendor's reply says answered, when it named
	// one — which may not be the one it was asked for
	Served string `json:"served,omitempty"`
	// Upstream: the provider an aggregator says answered behind it
	// (OpenRouter's "provider": DeepInfra, Novita …), when it says one
	Upstream string `json:"upstream,omitempty"`
	// RequestID: the id the vendor gave the request, from its reply's
	// headers (Claude Code's own for a subscription); ErrType: what a
	// failed request's error body called the error
	RequestID string `json:"request_id,omitempty"`
	// ResponseID is the final client response ID, independent of request headers.
	ResponseID string `json:"response_id,omitempty"`
	ErrType    string `json:"err_type,omitempty"`
	// Stop is why the upstream said its reply ended, in its own words
	// (stop_reason, finish_reason, a Responses status): "" when it said
	// none, as a stream that just stops does (upstreamStop)
	Stop string `json:"stop,omitempty"`
	// Tier is the service tier the reply says it ran at (upstreamTier),
	// "" when it says none
	Tier string `json:"tier,omitempty"`
	// Deferred is what the reply counted of earlier requests of its
	// conversation, which their own replies couldn't (cUsage's
	// MagpieDeferred): billed with this one, never told as its prompt
	Deferred *Usage `json:"deferred,omitempty"`
	// Credits is what the reply said the request cost in its plan's own
	// credits, nil when it said none: WorkBuddy's usage.credit, the
	// figure its app shows on each reply as "Credits Consumed" (#2512)
	Credits *float64 `json:"credits,omitempty"`
}

type ChatUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	TotalTokens         int `json:"total_tokens"`
	PromptTokensDetails *struct {
		CachedTokens     int `json:"cached_tokens"`
		CacheWriteTokens int `json:"cache_write_tokens"` // OpenRouter's
	} `json:"prompt_tokens_details,omitempty"`
	CompletionTokensDetails *struct {
		ReasoningTokens int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details,omitempty"`
	// what others say was read from their cache, when prompt_tokens_details
	// doesn't: DeepSeek's hits, Moonshot's cached_tokens, and Anthropic's
	// own names from relays in front of Claude
	PromptCacheHitTokens     int `json:"prompt_cache_hit_tokens"`
	CachedTokens             int `json:"cached_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	// Credit is what WorkBuddy says the request cost in its plan's credits
	Credit *float64 `json:"credit"`
	// what a plugin's step collected of its conversation's earlier steps,
	// which their own replies couldn't count (the Cursor plugin's usage
	// events that showed late, yetone/magpie#1053): billed with the step,
	// never its prompt, which a client reads as how full its context is
	MagpieDeferred *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		CachedTokens     int `json:"cached_tokens"`
		CacheWriteTokens int `json:"cache_write_tokens"`
	} `json:"magpie_deferred,omitempty"`
	// MagpieCacheUnknown: a plugin's usage saying its vendor gave no cache
	// counts, as aUsage's CacheUnknown, so the zero is not a miss: Trae's
	// token_usage naming no cache field (yetone/magpie#3991, #3979).
	// It is read, never told: chat() leaves it out.
	MagpieCacheUnknown bool `json:"magpie_cache_unknown"`
}

func (u ChatUsage) Usage() Usage {
	out := Usage{Output: u.CompletionTokens, cacheUnknown: u.MagpieCacheUnknown}
	if d := u.PromptTokensDetails; d != nil {
		out.CacheRead, out.CacheWrite = d.CachedTokens, d.CacheWriteTokens
	}
	for _, n := range []int{u.PromptCacheHitTokens, u.CachedTokens} {
		if out.CacheRead == 0 {
			out.CacheRead = n
		}
	}
	whole := true // prompt_tokens counts what was cached too, as OpenAI's does
	if out.CacheRead == 0 && out.CacheWrite == 0 {
		out.CacheRead, out.CacheWrite = u.CacheReadInputTokens, u.CacheCreationInputTokens
		// Anthropic's names, and less than they come to: counted as
		// Anthropic counts, only what was neither read nor written
		whole = u.PromptTokens >= out.CacheRead+out.CacheWrite
	}
	out.Input = u.PromptTokens
	if whole {
		out.Input = max(u.PromptTokens-out.CacheRead-out.CacheWrite, 0)
	}
	if u.CompletionTokensDetails != nil {
		out.Reasoning = u.CompletionTokensDetails.ReasoningTokens
	}
	if c := u.Credit; c != nil && *c >= 0 {
		out.Credits = c
	}
	if d := u.MagpieDeferred; d != nil && d.PromptTokens+d.CompletionTokens > 0 {
		out.Deferred = &Usage{Input: max(d.PromptTokens-d.CachedTokens-d.CacheWriteTokens, 0), Output: d.CompletionTokens,
			CacheRead: d.CachedTokens, CacheWrite: d.CacheWriteTokens}
	}
	return out
}
