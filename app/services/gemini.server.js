/**
 * Gemini Service
 * Manages interactions with the Google Gemini API
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

/**
 * Creates a Gemini service instance using the Google Gen AI SDK
 * @param {string} apiKey - Gemini API key
 * @returns {Object} Service with methods for AI conversation
 */
export function createGeminiService(apiKey = process.env.GEMINI_API_KEY) {
  // Initialize Gemini client
  const genAI = new GoogleGenerativeAI(apiKey);

  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    console.log("\n================= NEW GEMINI API CALL =================");
    console.log(`[Gemini] Total messages history received: ${messages.length}`);
    console.log(`[Gemini] Available tools: ${tools ? tools.map(t => t.name).join(', ') : 'None'}`);

    const systemInstruction = getSystemPrompt(promptType);

    // Format tools for Gemini API
    const geminiTools = tools && tools.length > 0 ? [{
      functionDeclarations: tools.map(t => {
        // Create a deep copy of the input schema to remove any unsupported properties for Gemini
        const schema = JSON.parse(JSON.stringify(t.input_schema || { type: "object", properties: {} }));
        // Gemini doesn't support $schema, so we remove it if present
        if (schema.$schema) delete schema.$schema;
        
        return {
          name: t.name,
          description: t.description,
          parameters: schema
        };
      })
    }] : undefined;

    // Format messages - filter out any system messages and map to Gemini format
    const formattedMessages = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system') continue;

      const role = msg.role === 'assistant' ? 'model' : 'user';
      let parts = [];

      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text') {
            parts.push({ text: item.text });
          } else if (item.type === 'tool_use') {
            parts.push({
              functionCall: {
                name: item.name,
                args: item.input
              }
            });
          } else if (item.type === 'tool_result') {
            // Find the corresponding tool_use to get the function name
            let funcName = item.name || "unknown_function";
            if (!item.name) {
               for (let j = i - 1; j >= 0; j--) {
                  const prevMsg = messages[j];
                  if (prevMsg.role === 'assistant' && Array.isArray(prevMsg.content)) {
                     const call = prevMsg.content.find(c => c.type === 'tool_use' && c.id === item.tool_use_id);
                     if (call) { funcName = call.name; break; }
                  }
               }
            }
            parts.push({
              functionResponse: {
                name: funcName,
                response: { result: item.content }
              }
            });
          }
        }
      } else if (typeof msg.content === 'string' && msg.content.trim() !== '') {
        parts.push({ text: msg.content });
      }
      
      if (parts.length > 0) {
        formattedMessages.push({ role, parts });
      }
    }

    console.log("\n[Gemini] Sending messages to Gemini API...");
    console.log(`[Gemini] Model: ${AppConfig.api.defaultModel}`);
    console.log(`[Gemini] Last message in array:`, JSON.stringify(formattedMessages[formattedMessages.length - 1], null, 2));

    const modelParams = {
      model: AppConfig.api.defaultModel,
      systemInstruction: {
        role: "system",
        parts: [{ text: systemInstruction }]
      }
    };
    
    if (geminiTools) {
      modelParams.tools = geminiTools;
    }

    const model = genAI.getGenerativeModel(modelParams);

    const stream = await model.generateContentStream({
      contents: formattedMessages
    });

    console.log("[Gemini] Stream connected, receiving response...");

    let fullContent = "";
    const toolUseBlocks = [];
    let stopReason = "end_turn"; // default

    // Process stream events
    for await (const chunk of stream) {
      let chunkText = "";
      try {
        chunkText = chunk.text();
      } catch (e) {
        // Ignore error if text is not available (e.g., when it's only a function call)
      }
      
      if (chunkText) {
        fullContent += chunkText;
        if (streamHandlers.onText) streamHandlers.onText(chunkText);
        if (streamHandlers.onContentBlock) streamHandlers.onContentBlock({ type: 'text', text: chunkText });
      }

      // Check for function calls in the chunk
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        for (const call of chunk.functionCalls) {
          toolUseBlocks.push(call);
        }
        stopReason = "tool_use";
      }
    }

    console.log("\n[Gemini] Stream Complete!");
    if (fullContent) console.log(`[Gemini] AI Reply Text: "${fullContent}"`);
    if (toolUseBlocks.length > 0) {
      console.log(`[Gemini] AI Requested Tools:`, JSON.stringify(toolUseBlocks, null, 2));
    }
    console.log("=====================================================\n");

    // Construct the final message object in Anthropic format (to maintain compatibility with the rest of the app)
    const anthropicFormatContent = [];
    
    if (fullContent) {
      anthropicFormatContent.push({
        type: "text",
        text: fullContent
      });
    }

    if (toolUseBlocks.length > 0) {
      for (const call of toolUseBlocks) {
        anthropicFormatContent.push({
          type: "tool_use",
          id: `call_${Math.random().toString(36).substring(2, 11)}`,
          name: call.name,
          input: call.args
        });
      }
    }

    const result = {
      role: "assistant",
      content: anthropicFormatContent,
      stop_reason: stopReason
    };

    if (streamHandlers.onMessage) {
      streamHandlers.onMessage(result);
    }

    if (streamHandlers.onToolUse) {
      for (const item of anthropicFormatContent) {
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
  createGeminiService
};
