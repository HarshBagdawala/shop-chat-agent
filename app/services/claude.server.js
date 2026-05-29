/**
 * Claude Service
 * Manages interactions with the Anthropic Claude API
 */
import Anthropic from "@anthropic-ai/sdk";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

/**
 * Creates a Claude service instance using the Anthropic SDK
 * @param {string} apiKey - Anthropic/Claude API key
 * @returns {Object} Service with methods for AI conversation
 */
export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  // Initialize Anthropic client
  const anthropic = new Anthropic({
    apiKey: apiKey,
  });

  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    console.log("\n================= NEW CLAUDE API CALL =================");
    console.log(`[Claude] Total messages history received: ${messages.length}`);
    console.log(`[Claude] Available tools: ${tools ? tools.map(t => t.name).join(', ') : 'None'}`);

    const systemInstruction = getSystemPrompt(promptType);

    // Format tools for Anthropic API (already in Anthropic format from MCP)
    const anthropicTools = tools && tools.length > 0 ? tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    })) : undefined;

    // Format messages - filter out any system messages and ensure proper format
    const formattedMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // System prompt is sent separately in Anthropic API

      if (Array.isArray(msg.content)) {
        formattedMessages.push({
          role: msg.role,
          content: msg.content
        });
      } else {
        formattedMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    console.log("\n[Claude] Sending messages to Claude API...");
    console.log(`[Claude] Model: ${AppConfig.api.defaultModel}`);
    console.log(`[Claude] Last message in array:`, JSON.stringify(formattedMessages[formattedMessages.length - 1], null, 2));

    // Create Anthropic stream
    const streamParams = {
      model: AppConfig.api.defaultModel,
      max_tokens: AppConfig.api.maxTokens,
      system: systemInstruction,
      messages: formattedMessages,
    };

    if (anthropicTools && anthropicTools.length > 0) {
      streamParams.tools = anthropicTools;
    }

    const stream = anthropic.messages.stream(streamParams);

    console.log("[Claude] Stream connected, receiving response...");

    let fullContent = "";
    const toolUseBlocks = [];

    // Process stream events
    stream.on('text', (text) => {
      fullContent += text;
      if (streamHandlers.onText) streamHandlers.onText(text);
      if (streamHandlers.onContentBlock) streamHandlers.onContentBlock({ type: 'text', text: text });
    });

    stream.on('contentBlock', (block) => {
      if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    });

    // Wait for stream to complete
    const finalMessage = await stream.finalMessage();

    console.log("\n[Claude] Stream Complete!");
    if (fullContent) console.log(`[Claude] AI Reply Text: "${fullContent}"`);
    if (toolUseBlocks.length > 0) {
      console.log(`[Claude] AI Requested Tools:`, JSON.stringify(toolUseBlocks.map(t => ({ name: t.name, input: t.input })), null, 2));
    }
    console.log("=====================================================\n");

    // Construct the final message object (already in Anthropic format)
    const result = {
      role: finalMessage.role,
      content: finalMessage.content,
      stop_reason: finalMessage.stop_reason
    };

    if (streamHandlers.onMessage) {
      streamHandlers.onMessage(result);
    }

    if (streamHandlers.onToolUse) {
      for (const item of finalMessage.content) {
        if (item.type === "tool_use") {
          await streamHandlers.onToolUse(item);
        }
      }
    }

    return result;
  };

  const getSystemPrompt = (promptType) => {
    return systemPrompts.systemPrompts[promptType]?.content ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content;
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default {
  createClaudeService
};
