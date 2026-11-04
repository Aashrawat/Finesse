"""OpenAI streaming and conversation history across model-selected MCP tool calls."""
from dataclasses import dataclass, field

from core.kb import config
from core.kb.clients import async_client

@dataclass
class Call:
    id: str
    name: str
    arguments: dict


@dataclass
class Round:
    calls: list[Call] = field(default_factory=list)
    output_tokens: int = 0


def openai_input(messages: list[dict]) -> list[dict]:
    converted = []
    for message in messages:
        content = message["content"]
        if isinstance(content, list):
            content = [{"type": "input_text", "text": part["text"]} if part["type"] == "text"
                       else {"type": "input_image", "image_url": part["image_url"]["url"], "detail": part["image_url"].get("detail", "auto")}
                       for part in content]
        converted.append({"role": message["role"], "content": content})
    return converted


class OpenAIConversation:
    def __init__(self, messages: list[dict], model: str, instructions: str, tools: list, usage):
        self.input = openai_input(messages)
        self.model, self.instructions, self.usage = model, instructions, usage
        self.tools = [{"type": "function", "name": tool.name, "description": tool.description, "parameters": tool.schema, "strict": False} for tool in tools]

    async def stream(self, result: Round, remaining: int, final: bool = False):
        import json
        options = {"model": self.model, "instructions": self.instructions, "input": self.input,
                   "stream": True, "store": False, "max_output_tokens": remaining}
        if self.tools:
            options.update(tools=self.tools, tool_choice="none" if final else "auto")
        if self.model.startswith(("gpt-5", "gpt-6")):
            if config.REASONING_EFFORT:
                options["reasoning"] = {"effort": config.REASONING_EFFORT}
            options["text"] = {"verbosity": "medium"}
            options["include"] = ["reasoning.encrypted_content"]
        response = None
        stream = await async_client().responses.create(**options)
        async with stream:
            async for event in stream:
                if event.type == "response.output_text.delta":
                    yield event.delta
                elif event.type in {"response.completed", "response.incomplete"}:
                    response = event.response
                elif event.type in {"response.failed", "error"}:
                    raise RuntimeError("The AI provider could not finish this reply. Please try again.")
        if response is None:
            raise RuntimeError("The AI provider ended the stream before completing the reply.")
        self.usage.prompt += getattr(response.usage, "input_tokens", 0) or 0
        result.output_tokens = getattr(response.usage, "output_tokens", 0) or 0
        self.usage.completion += result.output_tokens
        self.input.extend(response.output)
        for item in response.output:
            if item.type == "function_call":
                try:
                    arguments = json.loads(item.arguments)
                except (ValueError, TypeError):
                    arguments = {}
                result.calls.append(Call(item.call_id, item.name, arguments))

    def add_results(self, results: list[tuple[Call, dict]]):
        import json
        self.input.extend({"type": "function_call_output", "call_id": call.id, "output": json.dumps(data, ensure_ascii=False, default=str)} for call, data in results)
