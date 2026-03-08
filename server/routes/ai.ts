import { Router, Request, Response } from 'express';
import { logger } from '../db.js';

const router = Router();

// OpenRouter API configuration
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  logger.warn('OPENROUTER_API_KEY not set - AI features will not work');
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' };
}

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  error?: {
    message: string;
  };
}

/**
 * Helper function to call OpenRouter API
 */
async function callOpenRouter(request: OpenRouterRequest): Promise<any> {
  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://helmiesbites.com',
        'X-Title': 'Helmies Bites Platform'
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
    }

    const data: OpenRouterResponse = await response.json();

    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message}`);
    }

    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No content in OpenRouter response');
    }

    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  } catch (error) {
    logger.error('OpenRouter API call failed:', error);
    throw error;
  }
}

/**
 * POST /api/ai/parse-menu
 * Parse menu document with AI (text-based description or base64 image)
 */
router.post('/parse-menu', async (req: Request, res: Response) => {
  try {
    const { menuData, contentType = 'text' } = req.body;

    if (!menuData) {
      return res.status(400).json({ error: 'menuData is required' });
    }

    let userMessage = '';

    if (contentType === 'image' && menuData.startsWith('data:')) {
      // Base64 encoded image
      userMessage = [
        {
          type: 'text',
          text: `Extract all menu items, categories, and prices from this menu image.
Return the data as a JSON object with this structure:
{
  "categories": [
    {
      "name": "Category Name",
      "name_en": "English Category Name",
      "items": [
        {
          "name": "Item Name",
          "name_en": "English Item Name",
          "description": "Description in Finnish",
          "description_en": "Description in English",
          "price": 12.50,
          "allergens": ["G", "L"],
          "dietary": ["vegetarian", "gluten-free"]
        }
      ]
    }
  ],
  "restaurantInfo": {
    "name": "Restaurant Name",
    "cuisine": "Cuisine Type",
    "description": "Brief description"
  }
}`
        },
        {
          type: 'image_url',
          image_url: { url: menuData }
        }
      ];
    } else {
      // Text-based menu
      userMessage = `Parse this menu data and return a structured JSON:\n\n${menuData}\n\n
Return the data as a JSON object with categories, items, prices, descriptions in both Finnish and English.`;
    }

    const request: OpenRouterRequest = {
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'You are a professional menu parser. Extract menu items, categories, prices, and descriptions. Always return valid JSON with Finnish and English translations.'
        },
        {
          role: 'user',
          content: contentType === 'image' ? JSON.stringify(userMessage) : userMessage
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    };

    const result = await callOpenRouter(request);

    // Generate Swedish translation if needed
    const swedishResult = await callOpenRouter({
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'Translate the following menu data to Swedish. Return the same JSON structure with name_sv and description_sv fields added.'
        },
        {
          role: 'user',
          content: JSON.stringify(result)
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    // Merge the results
    const mergedResult = mergeTranslations(result, swedishResult);

    res.json({
      success: true,
      data: mergedResult
    });
  } catch (error) {
    logger.error('Menu parsing failed:', error);
    res.status(500).json({
      error: 'Failed to parse menu',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Helper to merge translations
 */
function mergeTranslations(original: any, translations: any): any {
  if (Array.isArray(original)) {
    return original.map((item, i) => mergeTranslations(item, translations?.[i]));
  }

  if (typeof original === 'object' && original !== null) {
    const merged: any = { ...original };
    if (translations && typeof translations === 'object') {
      for (const key in translations) {
        if (key.endsWith('_sv') || !merged[key]) {
          merged[key] = translations[key];
        } else if (typeof merged[key] === 'object') {
          merged[key] = mergeTranslations(merged[key], translations[key]);
        }
      }
    }
    return merged;
  }

  return original;
}

/**
 * POST /api/ai/generate-images
 * Generate images with AI (returns prompts/image URLs)
 */
router.post('/generate-images', async (req: Request, res: Response) => {
  try {
    const { menuItems, theme } = req.body;

    if (!menuItems || !Array.isArray(menuItems)) {
      return res.status(400).json({ error: 'menuItems array is required' });
    }

    const imagePrompts = menuItems.map((item: any) => {
      const cuisine = item.cuisine || 'restaurant';
      const style = theme?.style || 'modern food photography';
      const colors = theme?.colors?.primary || 'warm natural';

      return {
        menuItemId: item.id,
        name: item.name,
        nameEn: item.name_en,
        prompt: `Professional food photography of ${item.name_en || item.name}, ${cuisine} cuisine, ${style} style, ${colors} color palette, restaurant quality lighting, garnished, on a clean plate, high resolution, appetizing presentation`,
        negativePrompt: 'blurry, low quality, messy presentation, dark lighting, unappetizing'
      };
    });

    // In production, you would call an image generation API here
    // For now, return the prompts that would be used
    res.json({
      success: true,
      imagePrompts,
      note: 'Image generation requires additional API integration (DALL-E, Stable Diffusion, etc.)'
    });
  } catch (error) {
    logger.error('Image generation failed:', error);
    res.status(500).json({
      error: 'Failed to generate image prompts',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/ai/generate-branding
 * Generate branding with AI
 */
router.post('/generate-branding', async (req: Request, res: Response) => {
  try {
    const { restaurantName, cuisine, preferences } = req.body;

    if (!restaurantName) {
      return res.status(400).json({ error: 'restaurantName is required' });
    }

    // Generate color palette
    const colorRequest: OpenRouterRequest = {
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'Generate a professional color palette for a restaurant. Return JSON with "primary", "secondary", "accent", and "neutral" colors as hex values. Include a "description" explaining the mood.'
        },
        {
          role: 'user',
          content: `Generate a color palette for a ${cuisine || 'modern'} restaurant named "${restaurantName}". ${preferences ? `Preferences: ${preferences}` : ''}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7
    };

    const colors = await callOpenRouter(colorRequest);

    // Generate logo prompt
    const logoPrompt = `Modern, minimalist restaurant logo for "${restaurantName}", ${cuisine || 'fine dining'} cuisine, ${colors?.primary || '#e65100'} as primary color, clean typography, simple icon, professional design`;

    // Generate font suggestions
    const fontRequest: OpenRouterRequest = {
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'Suggest Google Fonts for a restaurant brand. Return JSON with "heading", "body", and "accent" font pairs.'
        },
        {
          role: 'user',
          content: `Suggest fonts for a ${cuisine || 'modern'} restaurant named "${restaurantName}" that match a ${colors?.description || 'warm and inviting'} aesthetic.`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5
    };

    const fonts = await callOpenRouter(fontRequest);

    res.json({
      success: true,
      branding: {
        colors,
        logoPrompt,
        fonts,
        logoImagePrompt: `Professional vector logo design for "${restaurantName}" restaurant, ${cuisine || 'modern'} style, using ${colors?.primary || '#e65100'} as accent color, clean minimalist typography, simple icon element, scalable, transparent background`
      }
    });
  } catch (error) {
    logger.error('Branding generation failed:', error);
    res.status(500).json({
      error: 'Failed to generate branding',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/ai/translate
 * Translate content
 */
router.post('/translate', async (req: Request, res: Response) => {
  try {
    const { content, targetLanguages = ['en', 'sv'] } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'content is required' });
    }

    const translations: Record<string, any> = {};

    for (const lang of targetLanguages) {
      const langName = lang === 'fi' ? 'Finnish' : lang === 'sv' ? 'Swedish' : 'English';

      const request: OpenRouterRequest = {
        model: 'openrouter/free',
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate content to ${langName}. Preserve formatting and structure. Return valid JSON matching the input structure.`
          },
          {
            role: 'user',
            content: typeof content === 'string' ? content : JSON.stringify(content)
          }
        ],
        temperature: 0.2
      };

      try {
        const result = await callOpenRouter(request);
        translations[lang] = result;
      } catch (error) {
        logger.error(`Translation to ${lang} failed:`, error);
        translations[lang] = null;
      }
    }

    res.json({
      success: true,
      translations,
      original: content
    });
  } catch (error) {
    logger.error('Translation failed:', error);
    res.status(500).json({
      error: 'Failed to translate content',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/ai/generate-theme
 * Generate theme with AI
 */
router.post('/generate-theme', async (req: Request, res: Response) => {
  try {
    const { restaurantName, cuisine, preferences } = req.body;

    const request: OpenRouterRequest = {
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: `Generate a complete restaurant website theme. Return JSON with:
{
  "name": "Theme Name",
  "description": "Theme description",
  "colors": {
    "primary": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": "#hex",
    "foreground": "#hex",
    "muted": "#hex",
    "card": "#hex"
  },
  "fonts": {
    "heading": "Font Name",
    "body": "Font Name"
  },
  "borderRadius": "value",
  "style": "modern|classic|rustic|minimalist|elegant"
}`
        },
        {
          role: 'user',
          content: `Generate a theme for a ${cuisine || 'modern'} restaurant named "${restaurantName}". ${preferences ? `Style preferences: ${preferences}` : 'Make it modern and appetizing.'}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8
    };

    const theme = await callOpenRouter(request);

    res.json({
      success: true,
      theme
    });
  } catch (error) {
    logger.error('Theme generation failed:', error);
    res.status(500).json({
      error: 'Failed to generate theme',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/ai/generate-description
 * Generate restaurant description with AI
 */
router.post('/generate-description', async (req: Request, res: Response) => {
  try {
    const { restaurantName, cuisine, specialities, city } = req.body;

    const request: OpenRouterRequest = {
      model: 'openrouter/free',
      messages: [
        {
          role: 'system',
          content: 'Generate an attractive restaurant description. Return JSON with "fi", "en", and "sv" keys containing descriptions in each language.'
        },
        {
          role: 'user',
          content: `Generate descriptions for a ${cuisine || 'modern'} restaurant named "${restaurantName}" in ${city || 'Finland'}. ${specialities ? `Specialities: ${specialities}` : ''}. Make it sound appealing and professional.`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7
    };

    const descriptions = await callOpenRouter(request);

    res.json({
      success: true,
      descriptions
    });
  } catch (error) {
    logger.error('Description generation failed:', error);
    res.status(500).json({
      error: 'Failed to generate descriptions',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
