import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { customsearch_v1, customsearch } from '@googleapis/customsearch';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Schema for environment variables
export const EnvSchema = z.object({
  GOOGLE_API_KEY: z.string().min(1, "Google API Key is required"),
  GOOGLE_SEARCH_ENGINE_ID: z.string().min(1, "Search Engine ID is required"),
});

// Parse and validate environment variables
const env = EnvSchema.safeParse(process.env);

if (!env.success) {
  console.error("❌ Invalid environment variables:", env.error.flatten().fieldErrors);
  process.exit(1);
}

// Now we have properly typed environment variables
const { GOOGLE_API_KEY, GOOGLE_SEARCH_ENGINE_ID } = env.data;

// Initialize the Custom Search API client
const searchClient = customsearch('v1');

// Schema for validating search arguments
export const SearchArgumentsSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().min(1).max(10).optional().default(5),
});

// Helper function to perform Google Custom Search
export async function performSearch(query: string, numResults: number): Promise<customsearch_v1.Schema$Search> {
  try {
    const response = await searchClient.cse.list({
      auth: GOOGLE_API_KEY,
      cx: GOOGLE_SEARCH_ENGINE_ID,
      q: query,
      num: numResults,
    });

    return response.data;
  } catch (error) {
    console.error("Error performing search:", error);
    throw error;
  }
}

// Format search results
export function formatSearchResults(searchData: customsearch_v1.Schema$Search): string {
  if (!searchData.items || searchData.items.length === 0) {
    return "No results found.";
  }

  const formattedResults = searchData.items.map((item, index) => {
    return [
      `Result ${index + 1}:`,
      `Title: ${item.title || 'No title'}`,
      `URL: ${item.link || 'No URL'}`,
      `Description: ${item.snippet || 'No description'}`,
      "---",
    ].join("\n");
  });

  return formattedResults.join("\n\n");
}

// Setup server function (exported for testing)
export default async function setupServer(): Promise<Server> {
  // Create server instance
  const server = new Server(
    {
      name: "google-custom-search",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search",
          description: "Search the web using Google Custom Search API",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query",
              },
              numResults: {
                type: "number",
                description: "Number of results to return (max 10)",
                default: 5,
              },
            },
            required: ["query"],
          },
        },
      ],
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "search") {
        const { query, numResults } = SearchArgumentsSchema.parse(args);
        
        const searchResults = await performSearch(query, numResults);
        const formattedResults = formatSearchResults(searchResults);

        return {
          content: [
            {
              type: "text",
              text: formattedResults,
            },
          ],
        };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid arguments: ${error.errors
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join(", ")}`
        );
      }
      
      // Improve error handling for API errors
      if (error instanceof Error) {
        return {
          content: [
            {
              type: "text",
              text: `Search failed: ${error.message}`,
            },
          ],
        };
      }
      throw error;
    }
  });

  return server;
}

// Start the server
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     process.argv[1]?.endsWith('index.js');

if (isMainModule) {
  async function main() {
    const server = await setupServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Google Custom Search MCP Server running on stdio");
  }

  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}