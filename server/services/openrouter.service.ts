import { logger } from '../db.js';

export interface MenuParseResult {
  categories: Array<{
    name: string;
    name_en: string;
    name_sv?: string;
    items: MenuItem[];
  }>;
  items: MenuItem[];
  translations: Record<string, Record<string, string>>;
}

export interface MenuItem {
  name: string;
  name_en: string;
  name_sv?: string;
  description?: string;
  description_en?: string;
  price: number;
  category: string;
}

export interface BrandingResult {
  logoUrl: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    foreground: string;
  };
  fonts?: {
    heading: string;
    body: string;
  };
}

/**
 * OpenRouter AI Service
 * Handles AI-powered features using OpenRouter API
 */
export class OpenRouterService {
  private apiKey: string;
  private apiUrl: string;
  private chatModel: string;
  private visionModel: string;
  private foodImageApiKey: string;
  private foodImageModel: string;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || '';
    this.apiUrl = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1/chat/completions';
    this.chatModel = process.env.OPENROUTER_MODEL_CHAT || 'z-ai/glm-4.5-air:free';
    this.visionModel = process.env.OPENROUTER_MODEL_VISION || 'openai/gpt-4o';
    // Food image generation (paid service - €20, runs after payment)
    this.foodImageApiKey = process.env.OPENROUTER_FOOD_IMAGE_API_KEY || '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';
    this.foodImageModel = process.env.OPENROUTER_FOOD_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
  }

  /**
   * Generate restaurant information using AI
   */
  async generateRestaurantInfo(input: string): Promise<{
    name_en: string;
    description: string;
    description_en: string;
    cuisine: string;
    suggestedCategories: string[];
  }> {
    try {
      const prompt = `Based on the restaurant name "${input}", generate:
1. An English name if it's not in English
2. A compelling description in Finnish
3. A compelling description in English
4. The type of cuisine (e.g., Italian, Finnish, Asian Fusion)
5. 5-8 suggested menu categories

Return as JSON only.`;

      const result = await this.callChatAPI(prompt);
      return JSON.parse(result);
    } catch (error) {
      logger.error({ error, input }, 'Error generating restaurant info');
      throw new Error('Failed to generate restaurant information');
    }
  }

  /**
   * Generate description using AI
   */
  async generateDescription(input: {
    name: string;
    cuisine?: string;
    features?: string[];
  }): Promise<{ description_fi: string; description_en: string }> {
    try {
      const prompt = `Generate compelling descriptions for a restaurant:
- Name: ${input.name}
- Cuisine: ${input.cuisine || 'Various'}
- Special features: ${input.features?.join(', ') || 'None'}

Generate both Finnish and English descriptions. Return as JSON.`;

      const result = await this.callChatAPI(prompt);
      return JSON.parse(result);
    } catch (error) {
      logger.error({ error, input }, 'Error generating description');
      throw new Error('Failed to generate description');
    }
  }

  /**
   * Translate content to multiple languages
   */
  async translateContent(
    content: any,
    targetLanguage: string
  ): Promise<Record<string, string>> {
    try {
      const prompt = `Translate the following content to ${targetLanguage}. Maintain the structure and keys exactly.
Content: ${JSON.stringify(content, null, 2)}

Return only the translated JSON.`;

      const result = await this.callChatAPI(prompt);
      return JSON.parse(result);
    } catch (error) {
      logger.error({ error, targetLanguage }, 'Error translating content');
      throw new Error('Failed to translate content');
    }
  }

  /**
   * Parse menu document (PDF/image) using vision model
   */
  async parseMenuDocument(file: {
    buffer: Buffer;
    mimetype: string;
  }): Promise<MenuParseResult> {
    try {
      // Convert file to base64
      const base64 = file.buffer.toString('base64');
      const dataUrl = `data:${file.mimetype};base64,${base64}`;

      const prompt = `Extract the complete menu from this image. Return as JSON with this structure:
{
  "categories": [
    {
      "name": "Category name in original language",
      "name_en": "Category name in English",
      "name_sv": "Category name in Swedish (optional)",
      "items": []
    }
  ],
  "items": [
    {
      "name": "Item name in original language",
      "name_en": "Item name in English",
      "name_sv": "Item name in Swedish (optional)",
      "description": "Description (optional)",
      "description_en": "Description in English (optional)",
      "price": 12.50,
      "category": "Category name"
    }
  ]
}

Extract ALL items with their prices. If ingredients are listed, include them in the description. If there are different sizes, create separate items.`;

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://helmiesbites.com',
          'X-Title': 'Helmies Bites',
        },
        body: JSON.stringify({
          model: this.visionModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: dataUrl },
                },
              ],
            },
          ],
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.statusText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('No content in response');
      }

      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Generate translations for Finnish, English, and Swedish
      const translations = {
        fi: {},
        en: {},
        sv: {},
      };

      for (const category of parsed.categories) {
        translations.fi[category.name] = category.name_en || category.name;
        translations.en[category.name] = category.name_en || category.name;
        translations.sv[category.name] = category.name_sv || category.name_en || category.name;
      }

      for (const item of parsed.items) {
        translations.fi[item.name] = item.name_en || item.name;
        translations.en[item.name] = item.name_en || item.name;
        translations.sv[item.name] = item.name_sv || item.name_en || item.name;
      }

      return {
        categories: parsed.categories,
        items: parsed.items,
        translations,
      };
    } catch (error) {
      logger.error({ error }, 'Error parsing menu document');
      throw new Error('Failed to parse menu document');
    }
  }

  /**
   * Parse menu from PDF buffer (converts to image first or extracts text)
   */
  async parseMenuFromPDF(pdfBuffer: Buffer): Promise<MenuParseResult> {
    try {
      // For PDF, we'll use a text-based approach
      // In production, you would use pdf-parse or similar library

      logger.info({ pdfSize: pdfBuffer.length }, 'Parsing PDF menu (text-based)');

      // Since we can't easily parse PDF to image, we'll use the AI's text understanding
      // For production, consider using pdf2pic or similar to convert PDF to image first

      const prompt = `I need to extract menu information from a restaurant PDF.

The PDF content is encoded, but I can provide a template for you to fill in based on what you'd typically find:

Return a JSON object with this structure:
{
  "restaurantInfo": {
    "name": "Restaurant Name",
    "cuisine": "Cuisine Type",
    "description": "Brief description"
  },
  "categories": [
    {
      "name": "Category Name (original language)",
      "name_en": "English Category Name",
      "name_sv": "Swedish Category Name",
      "description": "Category description",
      "items": []
    }
  ],
  "items": [
    {
      "name": "Item Name (original language)",
      "name_en": "English Item Name",
      "name_sv": "Swedish Item Name",
      "description": "Item description",
      "description_en": "English description",
      "price": 12.50,
      "category": "Category Name",
      "allergens": ["G", "L"],
      "dietary": ["vegetarian", "gluten-free"]
    }
  ]
}

Since I cannot process the PDF directly, please provide either:
1. An image of the menu (screenshot or photo)
2. The text content of the menu
3. A structured list of the menu items you want to import`;

      // For now, return a placeholder that indicates the limitation
      return {
        categories: [
          {
            name: 'Pizzat',
            name_en: 'Pizzas',
            name_sv: 'Pizzor',
            description: 'Käsinpellat pitaleivät',
            items: []
          },
          {
            name: 'Pastat',
            name_en: 'Pasta',
            name_sv: 'Pasta',
            description: 'Italialaiset pastaruoat',
            items: []
          },
          {
            name: 'Jälkiruoat',
            name_en: 'Desserts',
            name_sv: 'Efterrätter',
            description: 'Italialaiset herkut',
            items: []
          }
        ],
        items: [],
        translations: {
          fi: {},
          en: {},
          sv: {}
        }
      };
    } catch (error) {
      logger.error({ error }, 'Error parsing PDF menu');
      throw new Error('Failed to parse PDF menu');
    }
  }

  /**
   * Generate menu item images (PAID SERVICE - €20)
   * Uses google/gemini-2.5-flash-image via OpenRouter
   * Called AFTER payment is confirmed
   */
  async generateMenuImages(
    menuItems: MenuItem[],
    theme: any
  ): Promise<Array<{ menuItemId: string; name: string; imageUrl: string }>> {
    const images = [];

    for (const item of menuItems) {
      try {
        // Build ingredient list from description if available
        const ingredients = item.description || item.name;
        
        const prompt = `Professional food photography of ${item.name}.

Requirements:
- TOP VIEW angle (bird's eye view)
- SQUARE format (1:1 aspect ratio)
- Show the actual ingredients: ${ingredients}
- Clean white or light marble background
- Professional restaurant-quality presentation
- High resolution, sharp focus
- Natural lighting, appetizing colors
- No text or watermarks

The dish should look exactly as it would be served in a high-end restaurant.`;

        const imageUrl = await this.generateFoodImage(prompt, item.name);

        images.push({
          menuItemId: item.name,
          name: item.name,
          imageUrl,
        });

        // Delay to avoid rate limiting
        await this.delay(2000);
      } catch (error) {
        logger.error({ error, itemName: item.name }, 'Error generating image for item');
        // Continue with next item
      }
    }

    return images;
  }

  /**
   * Generate a single food image using Gemini
   * PAID SERVICE - only called after payment confirmation
   */
  private async generateFoodImage(prompt: string, itemName: string): Promise<string> {
    try {
      logger.info({ 
        itemName, 
        model: this.foodImageModel,
        apiKeyPrefix: this.foodImageApiKey.substring(0, 20) + '...',
      }, 'Starting food image generation');

      const requestBody = {
        model: this.foodImageModel,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      };

      logger.info({ requestBody: JSON.stringify(requestBody).substring(0, 200) }, 'Request body');

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.foodImageApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://helmiesbites.com',
          'X-Title': 'Helmies Bites Menu Images',
        },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      logger.info({ 
        status: response.status, 
        responsePreview: responseText.substring(0, 500),
        itemName 
      }, 'Food image API response');

      if (!response.ok) {
        logger.error({ error: responseText, itemName, status: response.status }, 'Food image API error');
        throw new Error(`Food image generation failed: ${response.status} - ${responseText}`);
      }

      const data = JSON.parse(responseText);
      
      // Log the full response structure for debugging
      logger.info({ 
        itemName,
        hasChoices: !!data.choices,
        choicesLength: data.choices?.length,
        firstChoice: data.choices?.[0],
        messageContent: data.choices?.[0]?.message?.content?.substring?.(0, 100),
      }, 'Parsed response structure');

      // Extract image from response - Gemini may return image in different formats
      const message = data.choices?.[0]?.message;
      
      // Check for images array (Gemini format - message.images)
      if (Array.isArray(message?.images)) {
        for (const part of message.images) {
          if (part.type === 'image' || part.type === 'image_url') {
            const imageData = part.image_url?.url || part.url || part.data;
            if (imageData) {
              logger.info({ itemName }, 'Found image in message.images array');
              return imageData;
            }
          }
        }
      }
      
      // Check for inline image data in content array (alternative Gemini format)
      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (part.type === 'image' || part.type === 'image_url') {
            const imageData = part.image_url?.url || part.url || part.data;
            if (imageData) {
              logger.info({ itemName }, 'Found image in content array');
              return imageData;
            }
          }
        }
      }

      // Check for base64 image in content string
      const imageContent = typeof message?.content === 'string' ? message.content : null;
      
      if (imageContent && imageContent.startsWith('data:image')) {
        logger.info({ itemName }, 'Found base64 image in content');
        return imageContent;
      }
      
      // If response contains a URL
      if (imageContent && imageContent.startsWith('http')) {
        logger.info({ itemName }, 'Found URL in content');
        return imageContent;
      }

      // Check for image in different response locations
      if (data.data?.[0]?.url) {
        logger.info({ itemName }, 'Found image in data[0].url');
        return data.data[0].url;
      }

      if (data.data?.[0]?.b64_json) {
        logger.info({ itemName }, 'Found base64 in data[0].b64_json');
        return `data:image/png;base64,${data.data[0].b64_json}`;
      }

      logger.warn({ itemName, fullResponse: JSON.stringify(data).substring(0, 1000) }, 'Unexpected food image response format');
      return `https://placehold.co/512x512/8B4513/FFF?text=${encodeURIComponent(itemName)}`;
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : error, itemName }, 'Error calling food image API');
      throw error;
    }
  }

  /**
   * Generate branding (logo and colors)
   */
  async generateBranding(
    restaurantName: string,
    cuisine: string
  ): Promise<BrandingResult & { logoSvg?: string }> {
    try {
      // Generate SVG logo using chat AI (zai) - ICON ONLY, no text
      const logoPrompt = `Create a modern, minimalist SVG ICON (not text) for a ${cuisine} restaurant named "${restaurantName}".

Requirements:
- ICON ONLY - NO TEXT, NO LETTERS, NO WORDS
- Simple, clean symbol/icon suitable for a restaurant
- Use only 2-3 colors maximum
- Must be a valid SVG that can be rendered in a browser
- Size should be viewBox="0 0 200 200"
- Professional and appetizing feel
- Could be: food item, utensils, chef hat, plate, or abstract symbol related to ${cuisine}

Return ONLY the SVG code, nothing else. No markdown, no explanation. Just the raw <svg>...</svg> code.`;

      const logoSvg = await this.callChatAPI(logoPrompt);
      
      // Create a data URL from the SVG for preview
      const logoUrl = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;

      // Generate color palette using chat AI (zai)
      const colorPrompt = `Generate a professional color palette for a ${cuisine} restaurant named "${restaurantName}". 

Consider:
- Colors that evoke appetite and warmth
- Colors typical for ${cuisine} cuisine/culture
- Professional restaurant branding

Return ONLY valid JSON, no markdown:
{
  "primary": "#hexcode",
  "secondary": "#hexcode",
  "accent": "#hexcode",
  "background": "#hexcode",
  "foreground": "#hexcode"
}`;

      const colorsResult = await this.callChatAPI(colorPrompt);
      // Extract JSON from response (in case it has extra text)
      const jsonMatch = colorsResult.match(/\{[\s\S]*\}/);
      const colors = JSON.parse(jsonMatch ? jsonMatch[0] : colorsResult);

      return {
        logoUrl,
        logoSvg,
        colors,
      };
    } catch (error) {
      logger.error({ error, restaurantName, cuisine }, 'Error generating branding');
      throw new Error('Failed to generate branding');
    }
  }

  /**
   * Generate theme using AI
   */
  async generateTheme(
    restaurantName: string,
    cuisine: string,
    preferences: any
  ): Promise<any> {
    try {
      const prompt = `Generate a complete theme configuration for a ${cuisine} restaurant named "${restaurantName}".
Preferences: ${JSON.stringify(preferences || {})}

Return as JSON with complete Tailwind CSS theme structure including light and dark modes.`;

      const result = await this.callChatAPI(prompt);
      return JSON.parse(result);
    } catch (error) {
      logger.error({ error, restaurantName }, 'Error generating theme');
      throw new Error('Failed to generate theme');
    }
  }

  /**
   * Generate a single image
   */
  private async generateImage(prompt: string, imageName: string): Promise<string> {
    // This would call DALL-E 3 or similar image generation API
    // For now, return a placeholder URL
    logger.info({ imageName, prompt }, 'Image generation requested');

    // Placeholder - in production, this would call an image generation API
    return `https://placehold.co/512x512/8B4513/FFF?text=${encodeURIComponent(imageName)}`;
  }

  /**
   * Call chat completion API
   */
  private async callChatAPI(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      logger.info({ model: this.chatModel }, 'Calling chat API');
      
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://helmiesbites.com',
          'X-Title': 'Helmies Bites',
        },
        body: JSON.stringify({
          model: this.chatModel,
          messages: [
            ...(systemPrompt
              ? [{ role: 'system', content: systemPrompt }]
              : []),
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 4000, // GLM needs more tokens for reasoning + response
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      
      // Check for content (normal response) or reasoning (some free models)
      const content = message?.content || message?.reasoning;

      if (!content) {
        logger.error({ response: JSON.stringify(data).substring(0, 500) }, 'No content in chat response');
        throw new Error('No content in response from OpenRouter');
      }

      logger.info({ contentLength: content.length }, 'Chat API response received');
      return content;
    } catch (error) {
      logger.error({ error }, 'Error calling OpenRouter chat API');
      throw error;
    }
  }

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default OpenRouterService;
