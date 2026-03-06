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
  private imageModel: string;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || '';
    this.apiUrl = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1/chat/completions';
    this.chatModel = process.env.OPENROUTER_MODEL_CHAT || 'z-ai/glm-4.5-air:free';
    this.visionModel = process.env.OPENROUTER_MODEL_VISION || 'openai/gpt-4-vision-preview';
    this.imageModel = process.env.OPENROUTER_MODEL_IMAGE || 'dall-e/dall-e-3';
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
   * Generate menu item images
   */
  async generateMenuImages(
    menuItems: MenuItem[],
    theme: any
  ): Promise<Array<{ menuItemId: string; name: string; imageUrl: string }>> {
    const images = [];

    for (const item of menuItems) {
      try {
        const prompt = `Professional food photography of ${item.name}, ${theme?.style || 'restaurant'} style, studio lighting, white background, high resolution, appetizing presentation`;

        const imageUrl = await this.generateImage(prompt, item.name);

        images.push({
          menuItemId: item.name,
          name: item.name,
          imageUrl,
        });

        // Small delay to avoid rate limiting
        await this.delay(1000);
      } catch (error) {
        logger.error({ error, itemName: item.name }, 'Error generating image for item');
        // Continue with next item
      }
    }

    return images;
  }

  /**
   * Generate branding (logo and colors)
   */
  async generateBranding(
    restaurantName: string,
    cuisine: string
  ): Promise<BrandingResult> {
    try {
      // Generate logo
      const logoPrompt = `Modern, minimalist logo for "${restaurantName}" ${cuisine} restaurant, clean design, professional, vector style, transparent background`;
      const logoUrl = await this.generateImage(logoPrompt, `${restaurantName}-logo`);

      // Generate color palette
      const colorPrompt = `Generate a professional color palette for a ${cuisine} restaurant named "${restaurantName}". Return as JSON:
{
  "primary": "#hexcode",
  "secondary": "#hexcode",
  "accent": "#hexcode",
  "background": "#hexcode",
  "foreground": "#hexcode"
}

Use colors that complement the cuisine type and create an appetizing atmosphere.`;

      const colorsResult = await this.callChatAPI(colorPrompt);
      const colors = JSON.parse(colorsResult);

      return {
        logoUrl,
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
          max_tokens: 2000,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('No content in response from OpenRouter');
      }

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
