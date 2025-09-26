import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { customsearch_v1, customsearch } from '@googleapis/customsearch';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

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

// Schema for validating text search arguments
export const SearchArgumentsSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().min(1).max(10).optional().default(5),
});

// Schema for validating image search arguments
export const ImageSearchArgumentsSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().min(1).max(10).optional().default(5),
  validateImages: z.boolean().optional().default(false),
  imgSize: z.enum(['huge', 'icon', 'large', 'medium', 'small', 'xlarge', 'xxlarge']).optional(),
  imgType: z.enum(['clipart', 'face', 'lineart', 'stock', 'photo', 'animated']).optional(),
  imgDominantColor: z.enum(['black', 'blue', 'brown', 'gray', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'white', 'yellow']).optional(),
  imgColorType: z.enum(['color', 'gray', 'mono', 'trans']).optional(),
});

// Helper function to perform Google Custom Text Search
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

// Helper function to perform Google Custom Image Search
export async function performImageSearch(
  query: string, 
  numResults: number,
  extraResults: number = 0,
  options: {
    imgSize?: string;
    imgType?: string;
    imgDominantColor?: string;
    imgColorType?: string;
  } = {}
): Promise<customsearch_v1.Schema$Search> {
  try {
    // Get up to numResults + extraResults images, capped at 10 which is the API limit
    const fetchCount = Math.min(numResults + extraResults, 10);
    
    const response = await searchClient.cse.list({
      auth: GOOGLE_API_KEY,
      cx: GOOGLE_SEARCH_ENGINE_ID,
      q: query,
      num: fetchCount,
      searchType: "image",
      // Add optional parameters if provided
      ...(options.imgSize && { imgSize: options.imgSize }),
      ...(options.imgType && { imgType: options.imgType }),
      ...(options.imgDominantColor && { imgDominantColor: options.imgDominantColor }),
      ...(options.imgColorType && { imgColorType: options.imgColorType }),
      // Filter out results from sites known for placeholder images
      filter: '1',  // Enable duplicate content filter
      safe: 'active' // Use safe search to avoid broken/placeholder images
    });

    return response.data;
  } catch (error) {
    console.error("Error performing image search:", error);
    throw error;
  }
}

// Helper function to check if an image URL exists and is actually a valid image
export async function checkImageExists(url: string): Promise<boolean> {
  try {
    // First try a HEAD request to quickly filter out obvious 404s
    const headResponse = await fetch(url, {
      method: 'HEAD',
      timeout: 3000, // 3 second timeout
    });
    
    if (!headResponse.ok) {
      return false;
    }
    
    // If HEAD request succeeds, do a GET request to check content type and size
    const getResponse = await fetch(url, {
      method: 'GET',
      timeout: 5000, // 5 second timeout
    });
    
    if (!getResponse.ok) {
      return false;
    }
    
    // Check if the content type is an image
    const contentType = getResponse.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      return false;
    }
    
    // Check if image size is reasonable (some placeholder images are very small)
    const contentLength = getResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) < 1000) {
      // Less than 1KB might be a placeholder
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`Error checking image URL ${url}:`, error);
    return false;
  }
}

// Check multiple image URLs in parallel with better error handling
export async function validateImageUrls(items: customsearch_v1.Schema$Result[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  
  if (!items || items.length === 0) {
    return results;
  }
  
  // Create checks with a timeout wrapper
  const checks = items.map(async (item) => {
    if (!item.link) return;
    
    try {
      // Add a Promise.race with a timeout to prevent hanging
      const exists = await Promise.race([
        checkImageExists(item.link),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 7000); // 7 second timeout for the entire check
        })
      ]);
      
      results.set(item.link, exists);
    } catch (error) {
      console.error(`Error validating image ${item.link}:`, error);
      results.set(item.link, false);
    }
  });
  
  // Wait for all checks to complete
  await Promise.all(checks);
  
  return results;
}

// Format text search results
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

// Format image search results
export function formatImageSearchResults(
  searchData: customsearch_v1.Schema$Search
): string {
  if (!searchData.items || searchData.items.length === 0) {
    return "No image results found.";
  }

  const formattedResults = searchData.items.map((item, index) => {
    return [
      `Image ${index + 1}:`,
      `Title: ${item.title || 'No title'}`,
      `Image URL: ${item.link || 'No URL'}`,
      `Thumbnail URL: ${item.image?.thumbnailLink || 'No thumbnail'}`,
      `Source: ${item.image?.contextLink || 'Unknown source'}`,
      `Size: ${item.image?.width || '?'}x${item.image?.height || '?'}`,
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
        {
          name: "imageSearch",
          description: "Search for images using Google Custom Search API",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The image search query",
              },
              numResults: {
                type: "number",
                description: "Number of image results to return (max 10)",
                default: 5,
              },
              validateImages: {
                type: "boolean",
                description: "Check if the image URLs are valid and accessible (filters out placeholders)",
                default: true,
              },
              imgSize: {
                type: "string",
                description: "Size of images to search for",
                enum: ["huge", "icon", "large", "medium", "small", "xlarge", "xxlarge"]
              },
              imgType: {
                type: "string", 
                description: "Type of images to search for",
                enum: ["clipart", "face", "lineart", "stock", "photo", "animated"]
              },
              imgDominantColor: {
                type: "string",
                description: "Dominant color of images to search for",
                enum: ["black", "blue", "brown", "gray", "green", "orange", "pink", "purple", "red", "teal", "white", "yellow"]
              },
              imgColorType: {
                type: "string",
                description: "Color type of images to search for",
                enum: ["color", "gray", "mono", "trans"]
              }
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
      } else if (name === "imageSearch") {
        const { 
          query, 
          numResults, 
          validateImages,
          imgSize,
          imgType,
          imgDominantColor,
          imgColorType
        } = ImageSearchArgumentsSchema.parse(args);
        
        // Fetch extra images (numResults + 5) to ensure we have enough valid ones
        const extraResultsCount = validateImages ? 5 : 0;
        const imageSearchResults = await performImageSearch(
          query, 
          numResults, 
          extraResultsCount,
          { 
            imgSize, 
            imgType, 
            imgDominantColor, 
            imgColorType 
          });
        
        if (!imageSearchResults.items || imageSearchResults.items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No image results found.",
              },
            ],
          };
        }

        if (validateImages) {
          console.error(`Validating ${imageSearchResults.items.length} image results...`);
          
          // Validate all fetched images
          const imageValidationMap = await validateImageUrls(imageSearchResults.items);
          
          // Filter out unreachable images
          const validItems = imageSearchResults.items.filter(item => 
            item.link && imageValidationMap.get(item.link) === true
          );
          
          console.error(`Found ${validItems.length} valid images out of ${imageSearchResults.items.length}`);
          
          if (validItems.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No valid images found. All images either failed validation or returned placeholders.",
                },
              ],
            };
          }
          
          // Limit to the originally requested number
          const limitedItems = validItems.slice(0, numResults);
          
          // Create a new search result object with only valid items
          const filteredResults: customsearch_v1.Schema$Search = {
            ...imageSearchResults,
            items: limitedItems,
            searchInformation: {
              ...imageSearchResults.searchInformation,
              totalResults: `${limitedItems.length}`
            }
          };
          
          // Add validation summary to results
          const validationSummary = 
            `Found ${validItems.length} valid images out of ${imageSearchResults.items.length} search results. ` +
            `Returning ${limitedItems.length} images.`;
          
          const formattedImageResults = formatImageSearchResults(filteredResults);
          
          return {
            content: [
              {
                type: "text",
                text: validationSummary + "\n\n" + formattedImageResults,
              },
            ],
          };
        } else {
          // No validation, just return all results
          const formattedImageResults = formatImageSearchResults(imageSearchResults);
          
          return {
            content: [
              {
                type: "text",
                text: formattedImageResults,
              },
            ],
          };
        }
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