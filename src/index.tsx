import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CATEGORIES, type Product } from './types'
import { getProducts, getAllProducts, saveProduct, deleteProduct, toggleFeatured } from './storage'

type Bindings = {
  PRODUCTS_KV: KVNamespace
  ARTICLES_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// Helper para KV
function getKV(c: any): KVNamespace | null {
  try {
    return c.env?.PRODUCTS_KV || null
  } catch {
    return null
  }
}

// === API ROUTES ===

// Listar categorias
app.get('/api/categories', (c) => {
  return c.json(CATEGORIES)
})

// Listar produtos de uma categoria
app.get('/api/products/:categoryId', async (c) => {
  const { categoryId } = c.req.param()
  const kv = getKV(c)
  const products = await getProducts(kv, categoryId)
  return c.json(products)
})

// Listar todos os produtos
app.get('/api/products', async (c) => {
  const kv = getKV(c)
  const products = await getAllProducts(kv)
  return c.json(products)
})

// Buscar metadados de URL (Open Graph scraping)
app.post('/api/fetch-metadata', async (c) => {
  try {
    const { url } = await c.req.json()
    if (!url) return c.json({ error: 'URL obrigatória' }, 400)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TeckhomeBot/1.0)',
        'Accept': 'text/html'
      },
      redirect: 'follow'
    })

    const html = await response.text()

    const getMetaContent = (property: string): string => {
      const patterns = [
        new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
        new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
      ]
      for (const re of patterns) {
        const m = html.match(re)
        if (m) return m[1].trim()
      }
      return ''
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = getMetaContent('og:title') || getMetaContent('twitter:title') || (titleMatch ? titleMatch[1].trim() : '') || 'Produto'
    const description = getMetaContent('og:description') || getMetaContent('description') || ''
    const imageUrl = getMetaContent('og:image') || getMetaContent('twitter:image') || ''

    // Tenta extrair preço
    const pricePatterns = [
      /R\$\s*[\d.,]+/gi,
      /"price":\s*"?([\d.,]+)"?/i,
      /data-price=["']([\d.,]+)["']/i
    ]
    let price = ''
    for (const pattern of pricePatterns) {
      const m = html.match(pattern)
      if (m) {
        price = m[0].replace(/"price":\s*"?/, 'R$ ').replace(/"?$/, '')
        break
      }
    }

    // Detecta loja
    const hostname = new URL(url).hostname.replace('www.', '')
    const storeMap: Record<string, string> = {
      'amazon.com.br': 'Amazon',
      'mercadolivre.com.br': 'Mercado Livre',
      'shopee.com.br': 'Shopee',
      'americanas.com.br': 'Americanas',
      'magazineluiza.com.br': 'Magazine Luiza',
      'casasbahia.com.br': 'Casas Bahia',
      'pontofrio.com.br': 'Ponto Frio',
      'extra.com.br': 'Extra',
      'submarino.com.br': 'Submarino',
      'kabum.com.br': 'KaBuM',
      'fastshop.com.br': 'FastShop',
      'aliexpress.com': 'AliExpress'
    }
    const store = storeMap[hostname] || hostname

    return c.json({ title, description, imageUrl, price, store, url })
  } catch (e) {
    return c.json({ error: 'Falha ao buscar metadados', title: '', description: '', imageUrl: '', price: '', store: '' }, 200)
  }
})

// Adicionar produto
app.post('/api/products', async (c) => {
  try {
    const body = await c.req.json()
    const { categoryId, title, description, imageUrl, productUrl, price, store } = body

    if (!categoryId || !productUrl) {
      return c.json({ error: 'categoryId e productUrl são obrigatórios' }, 400)
    }

    const cat = CATEGORIES.find(c => c.id === categoryId)
    if (!cat) return c.json({ error: 'Categoria inválida' }, 400)

    const product: Product = {
      id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      categoryId,
      title: title || 'Produto sem título',
      description: description || '',
      imageUrl: imageUrl || '',
      productUrl,
      price: price || '',
      store: store || '',
      rating: body.rating || 0,
      featured: false,
      createdAt: new Date().toISOString()
    }

    const kv = getKV(c)
    await saveProduct(kv, product)

    return c.json({ success: true, product }, 201)
  } catch (e) {
    return c.json({ error: 'Erro ao salvar produto' }, 500)
  }
})

// Atualizar produto
app.put('/api/products/:categoryId/:productId', async (c) => {
  try {
    const { categoryId, productId } = c.req.param()
    const body = await c.req.json()
    const kv = getKV(c)

    const products = await getProducts(kv, categoryId)
    const product = products.find(p => p.id === productId)
    if (!product) return c.json({ error: 'Produto não encontrado' }, 404)

    const updated = { ...product, ...body, id: productId, categoryId }
    await saveProduct(kv, updated)

    return c.json({ success: true, product: updated })
  } catch (e) {
    return c.json({ error: 'Erro ao atualizar produto' }, 500)
  }
})

// Deletar produto
app.delete('/api/products/:categoryId/:productId', async (c) => {
  const { categoryId, productId } = c.req.param()
  const kv = getKV(c)
  const ok = await deleteProduct(kv, categoryId, productId)

  if (!ok) return c.json({ error: 'Produto não encontrado' }, 404)
  return c.json({ success: true })
})

// Toggle destaque
app.patch('/api/products/:categoryId/:productId/featured', async (c) => {
  const { categoryId, productId } = c.req.param()
  const kv = getKV(c)
  const product = await toggleFeatured(kv, categoryId, productId)
  if (!product) return c.json({ error: 'Produto não encontrado' }, 404)
  return c.json({ success: true, product })
})

// Favicon — redireciona para a logo do site
app.get('/favicon.ico', (c) => {
  return c.redirect('/static/logo.png', 301)
})

// === PÁGINA PRINCIPAL ===
app.get('/', (c) => {
  return c.html(homePage())
})

// === PÁGINA DE CATEGORIA ===
app.get('/categoria/:id', (c) => {
  const { id } = c.req.param()
  const cat = CATEGORIES.find(cat => cat.id === id)
  if (!cat) return c.redirect('/')
  return c.html(categoryPage(cat.id))
})

// === AUTH ADMIN ===
const ADMIN_USER = 'admin'
const ADMIN_PASS = 'teckhome2026'
const COOKIE_NAME = 'teckhome_auth'
const COOKIE_VALUE = 'granted'
const MAINTENANCE_KEY = 'site:maintenance'

function isAuthenticated(c: any): boolean {
  const cookieHeader = c.req.header('Cookie') || ''
  return cookieHeader.includes(`${COOKIE_NAME}=${COOKIE_VALUE}`)
}

// Middleware de manutenção — bloqueia páginas públicas quando admin está logado
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  const isAdminPath = path.startsWith('/admin') || path.startsWith('/api/') || path.startsWith('/static') || path === '/favicon.ico' || path === '/sitemap.xml'
  if (isAdminPath) return next()
  // Verifica flag de manutenção no KV
  try {
    const kv = c.env?.PRODUCTS_KV
    if (kv) {
      const maint = await kv.get(MAINTENANCE_KEY)
      if (maint === '1') {
        return c.html(maintenancePage(), 503)
      }
    }
  } catch {}
  return next()
})

app.get('/admin', (c) => {
  if (!isAuthenticated(c)) return c.html(loginPage())
  return c.html(adminPage())
})

app.post('/admin/login', async (c) => {
  let username = ''
  let password = ''
  try {
    const body = await c.req.parseBody()
    username = (body['username'] as string || '').trim()
    password = (body['password'] as string || '').trim()
  } catch {
    const text = await c.req.text()
    const params = new URLSearchParams(text)
    username = (params.get('username') || '').trim()
    password = (params.get('password') || '').trim()
  }
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const res = c.redirect('/admin')
    res.headers.set('Set-Cookie', `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax; Secure`)
    return res
  }
  return c.html(loginPage('Usuário ou senha inválidos. Tente novamente.'))
})

app.get('/admin/logout', async (c) => {
  // Desativar modo manutenção ao sair do admin
  try {
    const kv = c.env?.PRODUCTS_KV
    if (kv) await kv.put(MAINTENANCE_KEY, '0')
  } catch {}
  const res = c.redirect('/')
  res.headers.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict`)
  return res
})

// === API: MANUTENÇÃO ===
app.post('/api/admin/maintenance', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  const kv = c.env?.PRODUCTS_KV
  let maintenance = false
  if (kv) {
    let body: any = {}
    try { body = await c.req.json() } catch {}
    if (body.force === true) {
      // Sempre ativar (chamado ao abrir o painel)
      await kv.put(MAINTENANCE_KEY, '1')
      maintenance = true
    } else {
      // Toggle
      const current = await kv.get(MAINTENANCE_KEY)
      maintenance = current !== '1'
      await kv.put(MAINTENANCE_KEY, maintenance ? '1' : '0')
    }
  }
  return c.json({ success: true, maintenance })
})

app.get('/api/admin/maintenance', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  const kv = c.env?.PRODUCTS_KV
  let maintenance = false
  if (kv) { const v = await kv.get(MAINTENANCE_KEY); maintenance = v === '1' }
  return c.json({ maintenance })
})

// === API: COMPARATIVOS ===
app.get('/api/comparativos', async (c) => {
  try {
    const kv = c.env?.ARTICLES_KV
    if (!kv) return c.json([])
    const data = await kv.get('comparativos:list')
    return c.json(data ? JSON.parse(data) : [])
  } catch { return c.json([]) }
})

app.get('/api/comparativos/:id', async (c) => {
  try {
    const kv = c.env?.ARTICLES_KV
    if (!kv) return c.json({ error: 'not found' }, 404)
    const id = c.req.param('id')
    const data = await kv.get(`comparativo:${id}`)
    if (!data) return c.json({ error: 'not found' }, 404)
    return c.json(JSON.parse(data))
  } catch { return c.json({ error: 'error' }, 500) }
})

app.post('/api/comparativos', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const kv = c.env?.ARTICLES_KV
    const body = await c.req.json()
    const id = `cmp_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
    const comparativo = { id, ...body, createdAt: new Date().toISOString() }
    if (kv) {
      await kv.put(`comparativo:${id}`, JSON.stringify(comparativo))
      const listData = await kv.get('comparativos:list')
      const list = listData ? JSON.parse(listData) : []
      const meta = { id, title: comparativo.title, category: comparativo.category, status: comparativo.status || 'active', products: (comparativo.products||[]).map((p:any)=>({id:p.id,name:p.name,image:p.image,price:p.price,rating:p.rating,badge:p.badge,affiliateUrl:p.affiliateUrl,pros:p.pros,cons:p.cons})), createdAt: comparativo.createdAt }
      list.unshift(meta)
      await kv.put('comparativos:list', JSON.stringify(list))
    }
    return c.json({ success: true, comparativo }, 201)
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

app.put('/api/comparativos/:id', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const kv = c.env?.ARTICLES_KV
    const id = c.req.param('id')
    const body = await c.req.json()
    const comparativo = { id, ...body, updatedAt: new Date().toISOString() }
    if (kv) {
      await kv.put(`comparativo:${id}`, JSON.stringify(comparativo))
      const listData = await kv.get('comparativos:list')
      const list = listData ? JSON.parse(listData) : []
      const idx = list.findIndex((x: any) => x.id === id)
      const meta = { id, title: comparativo.title, category: comparativo.category, status: comparativo.status || 'active', products: (comparativo.products||[]).map((p:any)=>({id:p.id,name:p.name,image:p.image,price:p.price,rating:p.rating,badge:p.badge,affiliateUrl:p.affiliateUrl,pros:p.pros,cons:p.cons})), createdAt: comparativo.createdAt, updatedAt: comparativo.updatedAt }
      if (idx >= 0) list[idx] = meta; else list.unshift(meta)
      await kv.put('comparativos:list', JSON.stringify(list))
    }
    return c.json({ success: true, comparativo })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

app.delete('/api/comparativos/:id', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const kv = c.env?.ARTICLES_KV
    const id = c.req.param('id')
    if (kv) {
      await kv.delete(`comparativo:${id}`)
      const listData = await kv.get('comparativos:list')
      const list = listData ? JSON.parse(listData) : []
      await kv.put('comparativos:list', JSON.stringify(list.filter((x: any) => x.id !== id)))
    }
    return c.json({ success: true })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

// === API: COMPARE OS PREÇOS ===
// Cada configuração de compare é armazenada como: pricecompare:{id} no ARTICLES_KV
// Lista: pricecompare:list

app.get('/api/pricecompare', async (c) => {
  try {
    const kv = c.env?.ARTICLES_KV
    if (!kv) return c.json([])
    const data = await kv.get('pricecompare:list')
    return c.json(data ? JSON.parse(data) : [])
  } catch { return c.json([]) }
})

app.get('/api/pricecompare/:id', async (c) => {
  try {
    const kv = c.env?.ARTICLES_KV
    if (!kv) return c.json({ error: 'not found' }, 404)
    const id = c.req.param('id')
    const data = await kv.get(`pricecompare:${id}`)
    if (!data) return c.json({ error: 'not found' }, 404)
    return c.json(JSON.parse(data))
  } catch { return c.json({ error: 'error' }, 500) }
})

app.post('/api/pricecompare', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const kv = c.env?.ARTICLES_KV
    const body = await c.req.json()
    const id = `pc_${Date.now()}_${Math.random().toString(36).slice(2,6)}`
    const config = {
      id,
      productName: body.productName || '',
      slug: body.slug || '',
      active: body.active !== false,
      showInArticle: body.showInArticle !== false,
      stores: body.stores || [],
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
    if (kv) {
      await kv.put(`pricecompare:${id}`, JSON.stringify(config))
      const listData = await kv.get('pricecompare:list')
      const list = listData ? JSON.parse(listData) : []
      list.unshift({ id, productName: config.productName, slug: config.slug, active: config.active, updatedAt: config.updatedAt })
      await kv.put('pricecompare:list', JSON.stringify(list))
    }
    return c.json({ success: true, config }, 201)
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

app.put('/api/pricecompare/:id', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const kv = c.env?.ARTICLES_KV
    const id = c.req.param('id')
    const body = await c.req.json()
    const config = { id, ...body, updatedAt: new Date().toISOString() }
    if (kv) {
      await kv.put(`pricecompare:${id}`, JSON.stringify(config))
      const listData = await kv.get('pricecompare:list')
      const list = listData ? JSON.parse(listData) : []
      const idx = list.findIndex((x: any) => x.id === id)
      const meta = { id, productName: config.productName, slug: config.slug, active: config.active, updatedAt: config.updatedAt }
      if (idx >= 0) list[idx] = meta; else list.unshift(meta)
      await kv.put('pricecompare:list', JSON.stringify(list))
    }
    return c.json({ success: true, config })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

app.delete('/api/pricecompare/:id', async (c) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const kv = c.env?.ARTICLES_KV
    const id = c.req.param('id')
    if (kv) {
      await kv.delete(`pricecompare:${id}`)
      const listData = await kv.get('pricecompare:list')
      const list = listData ? JSON.parse(listData) : []
      await kv.put('pricecompare:list', JSON.stringify(list.filter((x: any) => x.id !== id)))
    }
    return c.json({ success: true })
  } catch (e) { return c.json({ error: String(e) }, 500) }
})

// === API: ARTIGOS DO BLOG ===

// Listar artigos
app.get('/api/articles', async (c) => {
  try {
    const kv = c.env?.ARTICLES_KV
    if (!kv) return c.json([])
    const list = await kv.list({ prefix: 'article_' })
    const articles = await Promise.all(
      list.keys.map(async (k: any) => {
        const val = await kv.get(k.name)
        return val ? JSON.parse(val) : null
      })
    )
    const valid = articles.filter(Boolean).sort((a: any, b: any) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    return c.json(valid)
  } catch {
    return c.json([])
  }
})

// Criar artigo a partir de URL de produto
app.post('/api/articles', async (c) => {
  try {
    if (!isAuthenticated(c)) return c.json({ error: 'Não autorizado' }, 401)
    const body = await c.req.json()
    const { title, excerpt, content, category, categoryIcon, image, productUrl, store, readTime, keywords } = body
    if (!title) return c.json({ error: 'Título obrigatório' }, 400)

    const id = `article_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const slug = title.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60)

    const article = {
      id,
      slug,
      title,
      excerpt: excerpt || '',
      content: content || '',
      category: category || 'Geral',
      categoryIcon: categoryIcon || '📝',
      image: image || '',
      productUrl: productUrl || '',
      store: store || '',
      readTime: readTime || '5 min',
      keywords: keywords || '',
      url: `/artigo/${slug}`,
      createdAt: new Date().toISOString()
    }

    const kv = c.env?.ARTICLES_KV
    if (kv) await kv.put(id, JSON.stringify(article))

    return c.json({ success: true, article }, 201)
  } catch (e) {
    return c.json({ error: 'Erro ao criar artigo' }, 500)
  }
})

// Deletar artigo
app.delete('/api/articles/:id', async (c) => {
  try {
    if (!isAuthenticated(c)) return c.json({ error: 'Não autorizado' }, 401)
    const { id } = c.req.param()
    const kv = c.env?.ARTICLES_KV
    if (kv) await kv.delete(id)
    return c.json({ success: true })
  } catch {
    return c.json({ error: 'Erro ao deletar artigo' }, 500)
  }
})

// === PÁGINAS INFORMATIVAS ===
app.get('/termos-de-uso', (c) => {
  return c.html(termosPage())
})

app.get('/politica-de-privacidade', (c) => {
  return c.html(privacidadePage())
})

app.get('/politica-de-cookies', (c) => {
  return c.html(cookiesPage())
})

app.get('/sobre', (c) => {
  return c.html(sobrePage())
})

// === PÁGINA DE ARTIGO DO BLOG ===
app.get('/artigo/:slug', async (c) => {
  const { slug } = c.req.param()

  // Artigos estáticos embutidos
  const staticArticlesFull: Record<string, any> = {
    'guia-eletronicos': {
      slug: 'guia-eletronicos',
      title: 'Como escolher o melhor smartphone em 2026: tudo que você precisa saber antes de comprar',
      category: 'Eletrônicos', categoryIcon: '📱', categoryId: 'eletronicos',
      image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=1200&q=80',
      readTime: '6 min',
      keywords: 'melhor smartphone 2026, como escolher celular, review celular custo-benefício',
      excerpt: 'Você está prestes a gastar centenas de reais em um celular — e pode cometer o mesmo erro que milhares de brasileiros cometem todo ano.',
      content: `<h2>Por que a maioria das pessoas escolhe errado?</h2><p>O erro mais comum — e mais caro — é comprar um smartphone pela marca, pelo hype da propaganda ou simplesmente pelo preço mais baixo disponível, sem entender o que cada especificação realmente significa na prática do dia a dia. Isso gera frustração em menos de seis meses. Um celular com câmera de 108MP pode tirar fotos piores do que um modelo de 12MP bem calibrado por um fabricante experiente. Um processador "octa-core" de fabricante desconhecido pode ser mais lento, mais quente e mais lerdo do que modelos de geração anterior de marcas consolidadas. A informação que você precisa está abaixo — e a maioria dos vendedores jamais vai te contar.</p><h2>Os 5 critérios que realmente importam</h2><h3>1. Processador (chipset): o coração que ninguém mostra na embalagem</h3><p>O processador define tudo: velocidade de apps, qualidade de fotos, consumo de bateria e vida útil do aparelho. Para uso geral em 2026, os chips Snapdragon 7-series, Dimensity 900+ ou qualquer Apple A-series entregam excelente desempenho para 3-4 anos de uso confortável. Evite chipsets MediaTek Helio G ou P-series em aparelhos acima de R$ 1.500 — eles são chips de entrada disfarçados em produtos de preço médio-alto. Um bom teste prático: abra 8 apps diferentes e alterne rapidamente entre eles. Se o aparelho gaguejar ou recarregar os apps, o chip está subdimensionado.</p><h3>2. Bateria e carregamento: o critério mais subestimado</h3><p>Nada mais frustrante do que um celular morto no meio do dia. Para uso intenso (redes sociais, câmera, navegação e trabalho), o mínimo aceitável em 2026 é 4.500 mAh. Mas a capacidade sozinha não basta: a velocidade de carregamento muda completamente a relação com o aparelho. Um carregador de 33W leva um aparelho de 0% a 80% em aproximadamente 45 minutos. Um carregador de 120W faz isso em 20 minutos. Além disso, verifique se o aparelho possui carregamento sem fio — prático para quem tem base em casa ou no escritório.</p><h3>3. Sistema de câmera: ignore megapixels, olhe para o sensor</h3><p>A indústria usa megapixels como ferramenta de marketing, não de qualidade. O que realmente importa é o tamanho do sensor (quanto maior, melhor em ambientes escuros), a abertura da lente (f/1.8 ou menor capta mais luz), a presença de estabilização óptica de imagem (OIS) e a qualidade do processamento de imagem — que é software, não hardware. Antes de comprar, procure testes reais com fotos tiradas pelo modelo específico em condições de baixa luminosidade. Esse é o cenário mais revelador.</p><h3>4. Durabilidade de software: anos de atualização</h3><p>Um smartphone que para de receber atualizações de segurança se torna vulnerável — e gradualmente incompatível com novos apps. Em 2026, Samsung garante 7 anos de atualizações nos modelos Galaxy S e A; Apple garante suporte por 5-6 anos; Google Pixel garante 7 anos. Marcas menores frequentemente abandonam seus aparelhos em 18-24 meses. Esse critério afeta diretamente o valor de revenda do aparelho e a segurança dos seus dados bancários.</p><h3>5. Custo-benefício real: como verificar se a promoção é verdadeira</h3><p>Antes de finalizar qualquer compra, verifique o histórico de preços do produto usando ferramentas como o Zoom ou o Buscapé. Muitos aparelhos têm o preço inflado semanas antes de saldões para que o "desconto" pareça maior. Também considere o custo total: capinha, película de vidro temperado e fone bluetooth podem somar R$ 150-300 adicionais. Um celular com fone embutido ou com tela mais resistente pode economizar esse investimento.</p><h2>Faixas de preço e o que esperar de cada uma</h2><p><strong>Até R$ 1.000:</strong> Aparelhos funcionais para chamadas, redes sociais e foto casual. Não espere gaming intenso ou câmera profissional. Priorize bateria grande e processador decente.</p><p><strong>R$ 1.000 a R$ 2.500:</strong> A melhor relação custo-benefício do mercado. Nesta faixa, você obtém câmera excelente, processador rápido e 4-5 anos de uso confortável. A maioria das pessoas deveria comprar aqui.</p><p><strong>Acima de R$ 2.500:</strong> Recursos premium como zoom óptico 5x+, carregamento ultra-rápido, chassis de titânio e câmera de estúdio. Valem para profissionais de foto/vídeo e quem quer o topo absoluto.</p><h2>Nossa recomendação final</h2><p>Antes de finalizar qualquer compra, liste suas 3 prioridades — bateria, câmera ou performance? — e compare 2-3 modelos especificamente nessas categorias. Não deixe a propaganda decidir por você. Use os links verificados e atualizados da TeckHome Store para garantir a melhor oferta disponível, com preço histórico analisado pela nossa equipe editorial.</p>`
    },
    'guia-eletrodomesticos': {
      slug: 'guia-eletrodomesticos',
      title: 'Air fryer ou forno elétrico? A verdade que as marcas não te contam — e qual comprar em 2026',
      category: 'Eletrodomésticos', categoryIcon: '🏠', categoryId: 'eletrodomesticos',
      image: 'https://images.unsplash.com/photo-1585515320310-259814833e62?w=1200&q=80',
      readTime: '7 min',
      keywords: 'air fryer vs forno elétrico, melhor air fryer 2026, qual comprar',
      excerpt: 'A air fryer se tornou febre no Brasil — mas será que ela é realmente superior ao forno elétrico, ou é apenas marketing bem feito?',
      content: `<h2>A verdade sobre a air fryer que o marketing não conta</h2><p>A air fryer não frita de verdade — ela assa com circulação de ar quente em altíssima velocidade (tecnologia chamada de rapid air). O resultado é muito parecido com o forno, porém drasticamente mais rápido e com a vantagem de usar muito menos óleo. Para alimentos congelados, batata frita artesanal e frango temperado, ela é genuinamente imbatível no quesito crocância. Mas existem limitações reais que os anúncios nunca mostram, e que podem fazer você se arrepender da compra em poucas semanas.</p><h2>Quando a air fryer vence claramente</h2><ul><li><strong>Velocidade de preparo:</strong> Esquenta em 2-3 minutos vs. 10-15 minutos de um forno elétrico convencional. Para o dia a dia corrido, isso faz diferença enorme.</li><li><strong>Consumo de energia por uso:</strong> Gasta de 1.200 a 1.700W, mas por um tempo muito menor. O custo por preparo é equivalente ou inferior ao forno.</li><li><strong>Crocância incomparável:</strong> A circulação de ar em 360° cria uma casquinha dourada que o forno comum não consegue replicar com facilidade.</li><li><strong>Espaço compacto:</strong> Versões de 3-4L são ideais para cozinhas pequenas ou cozinhas de apartamento. Cabem em qualquer bancada.</li><li><strong>Facilidade de limpeza:</strong> A maioria das cestas e bandejas vai direto para a lava-louças. O forno elétrico exige muito mais trabalho de limpeza.</li></ul><h2>Quando o forno elétrico vence — e vence por larga margem</h2><ul><li><strong>Capacidade real:</strong> Assar um frango inteiro, uma pizza de 35cm, um bolo de forma grande ou preparar refeições para 4-6 pessoas simultaneamente é impossível em air fryers de até 8L.</li><li><strong>Versatilidade culinária:</strong> Gratinar massas, tostar fatias de pão, fazer pão caseiro, derreter queijo, ressecamento controlado de ervas — o forno elétrico é muito mais versátil para culinária variada.</li><li><strong>Custo de entrada:</strong> Fornos elétricos básicos de 44L custam entre R$ 180 e R$ 350. Uma boa air fryer de marca confiável começa em R$ 300 e pode chegar a R$ 800.</li><li><strong>Estabilidade para confeitaria:</strong> Bolos, quiches e pães exigem temperatura estável e distribuição uniforme de calor — o forno elétrico controla isso com muito mais precisão.</li></ul><h2>Quanto gasta cada aparelho na conta de luz?</h2><p>Aqui vai um cálculo real: uma air fryer de 1.500W usada 30 minutos por dia durante um mês consome 22,5 kWh. Com a tarifa média de R$ 0,90/kWh, isso representa R$ 20 por mês. Um forno de 1.800W usado nos mesmos 30 minutos diários consome 27 kWh, ou R$ 24 por mês. A diferença é pequena — o fator determinante é o tempo total de uso, não apenas a potência nominal do aparelho.</p><h2>O veredicto completo da Equipe TeckHome</h2><p><strong>Para solteiros ou casais sem filhos:</strong> Uma air fryer de 4-5L cobre 85-90% das necessidades culinárias e oferece praticidade incomparável no cotidiano. Priorize modelos com visor digital, capacidade de pelo menos 4L e potência de 1.500W+.</p><p><strong>Para famílias com crianças ou quem cozinha muito:</strong> Um forno elétrico de 44L ou mais é indispensável. Mas idealmente, ter os dois aparelhos é a combinação perfeita — eles se complementam e cobrem cenários completamente diferentes.</p><p><strong>Nossa recomendação de custo-benefício:</strong> Air fryer Mondial, Philips Walita ou Arno nas versões 5L+ para uso diário. Forno elétrico Britânia, Fischer ou Mallory nas versões 44L+ para preparo de refeições completas. Confira os links verificados da TeckHome Store para garantir o menor preço com garantia de autenticidade.</p>`
    },
    'guia-refrigeracao': {
      slug: 'guia-refrigeracao',
      title: 'Ar-condicionado em 2026: split, portátil ou janela? O guia definitivo para escolher sem erro',
      category: 'Refrigeração', categoryIcon: '❄️', categoryId: 'refrigeracao',
      image: 'https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=1200&q=80',
      readTime: '8 min',
      keywords: 'ar condicionado split vs portátil, melhor ar condicionado 2026, BTU ideal',
      excerpt: 'Comprar o ar-condicionado errado pode te custar mais de R$ 500 extras por ano só na conta de luz.',
      content: `<h2>O erro que custa caro todos os meses — e que 70% das pessoas cometem</h2><p>Comprar um ar-condicionado subdimensionado para o ambiente faz o compressor trabalhar em 100% da capacidade continuamente, sem nunca conseguir atingir a temperatura desejada. O resultado: conta de luz altíssima, equipamento desgastado antes do tempo e desconforto térmico mesmo com o aparelho ligado. O oposto também é ruim: um aparelho superdimensionado liga e desliga em ciclos curtos, cria excesso de umidade no ar, não filtra o ar adequadamente e ainda assim consome mais energia do que o necessário. Calcular o BTU correto é o primeiro passo obrigatório.</p><h2>Como calcular o BTU ideal para cada ambiente</h2><p>A fórmula básica amplamente utilizada por técnicos de HVAC é <strong>600 BTU por metro quadrado</strong>, válida para pé-direito padrão de 2,7m e clima quente como o brasileiro. Mas ajuste conforme as condições do seu ambiente:</p><ul><li><strong>+10% a +15%</strong> para ambientes com janelas voltadas para o oeste ou muita exposição ao sol direto na tarde</li><li><strong>+600 BTU</strong> para cada pessoa além de dois usuários regulares no ambiente</li><li><strong>+1.000 BTU</strong> para computadores desktop, TVs de 55" ou mais, ou qualquer fonte significativa de calor no ambiente</li><li><strong>-10%</strong> se o ambiente for sombreado e com boa ventilação natural cruzada</li></ul><p>Exemplo prático: quarto de 12m² com janela para o sol da tarde e 2 pessoas → 12 × 600 = 7.200 + 10% = ~8.000 BTU. O modelo mais próximo no mercado seria de 9.000 BTU.</p><h2>Split Inverter x Convencional x Portátil: a comparação honesta e completa</h2><h3>Split Inverter — o melhor para uso permanente</h3><p>O inverter é a tecnologia atual de referência. O compressor varia a rotação conforme a necessidade do ambiente, em vez de simplesmente ligar e desligar. Resultado: <strong>30-50% de economia em relação ao convencional</strong>, funcionamento muito mais silencioso (35-45 dB vs. 55-65 dB do convencional), vida útil maior do compressor e temperatura mais estável e confortável. O custo extra na compra (R$ 200-500 a mais) é recuperado em 12-24 meses de economia na conta de luz.</p><h3>Split Convencional — custo menor, mas mais gasto no longo prazo</h3><p>Ainda encontrado em modelos de entrada. Funciona em ciclos on/off, é mais barulhento e menos eficiente. Para uso ocasional (menos de 2h/dia), pode ser uma opção economicamente viável. Para uso diário, o inverter se paga facilmente.</p><h3>Portátil — conveniente mas ineficiente</h3><p>Sem instalação, move-se de cômodo para cômodo — parecem a solução perfeita para locação ou temporada. Mas a realidade é dura: consomem 2-3x mais energia por BTU entregue, fazem barulho significativo (60-70 dB), exigem obrigatoriamente uma mangueira de exaustão de ar quente para o exterior (sem isso, simplesmente não funcionam) e refrigeram um espaço bem menor do que a potência indicada sugere. Só compensa genuinamente em situações de locação com proibição de instalação fixa ou para uso de no máximo 3-4 meses por ano.</p><h2>O que observar na etiqueta Procel</h2><p>Todo ar-condicionado vendido no Brasil tem a etiqueta Procel com classificação de eficiência de A a G. Prefira sempre <strong>classificação A</strong>. A diferença de consumo entre um modelo A e um modelo C pode chegar a 40% ao ano — o que representa R$ 400-800 de diferença na conta de luz, dependendo do uso.</p><h2>Manutenção: o que ninguém faz mas todo mundo deveria</h2><p>Limpar o filtro do ar-condicionado mensalmente reduz em até 15% o consumo de energia e evita a proliferação de mofo, ácaros e bactérias que são lançados diretamente no ar que você respira. Higienização completa (incluindo serpentina e bandeja de condensado) deve ser feita semestralmente por técnico especializado — custa entre R$ 100 e R$ 250 e prolonga significativamente a vida útil do equipamento.</p><h2>Nossa recomendação definitiva</h2><p>Para uso permanente em quarto ou sala: <strong>split inverter classificação A</strong>, das marcas LG, Samsung, Daikin ou Midea — todas com excelente custo-benefício e rede de assistência técnica abrangente no Brasil. Para locação temporária ou quarto de hóspedes: portátil de 12.000 BTU. Confira os modelos selecionados e verificados pela Equipe TeckHome com preços históricos analisados.</p>`
    },
    'guia-ferramentas': {
      slug: 'guia-ferramentas',
      title: 'As 7 ferramentas elétricas que todo proprietário de imóvel precisa ter em casa',
      category: 'Ferramentas', categoryIcon: '🔧', categoryId: 'ferramentas',
      image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=1200&q=80',
      readTime: '6 min',
      keywords: 'ferramentas elétricas essenciais, melhor parafusadeira 2026, kit ferramentas casa',
      excerpt: 'Se você é proprietário de imóvel ou simplesmente gosta de resolver problemas em casa sem depender de terceiros, existem 7 ferramentas elétricas que vão transformar sua vida.',
      content: `<h2>Por que montar seu kit de ferramentas — e quanto você economiza</h2><p>Chamar um técnico para apertar parafusos, instalar uma prateleira, fixar uma pia ou fazer pequenos reparos domésticos custa entre R$ 80 e R$ 250 por visita, sem contar o tempo de espera que pode variar de dias a semanas. Com um kit de ferramentas básico que custa entre R$ 400 e R$ 800, você recupera o investimento em apenas 3-4 chamados evitados — e ganha a liberdade de resolver problemas no próprio ritmo, sem depender de agenda de terceiros. Além disso, pequenos reparos feitos na hora certa evitam que se tornem problemas grandes e caros no futuro.</p><h2>As 7 ferramentas essenciais para todo proprietário de imóvel</h2><h3>1. Parafusadeira/furadeira elétrica — a rainha do kit doméstico</h3><p>Sozinha, essa ferramenta resolve 60% de todos os trabalhos domésticos. Procure modelos com torque ajustável (mínimo 18 configurações), bateria de lítio de 20V ou mais, velocidade variável e kit completo com brocas para concreto, madeira e metal. As marcas Bosch GSB 20-2 e Makita HP1631K são referência de durabilidade e custo-benefício. Para uso mais leve, Tramontina Pro e Black+Decker entregam boa qualidade por menos. Prefira sempre modelos com duas baterias para não parar no meio do trabalho.</p><h3>2. Nível a laser — precisão sem esforço</h3><p>Instalar quadros, prateleiras, móveis e rodapés nivelados sem um nível a laser é gastar horas com fio de prumo e ainda assim errar. Modelos de linha cruzada (que projetam duas linhas perpendiculares simultâneas) a partir de R$ 80 já resolvem 95% das necessidades domésticas. Para uso profissional ou obras maiores, nivéis de 3 linhas com alcance de 30m+ valem o investimento adicional.</p><h3>3. Serra circular ou tico-tico — para quem trabalha com madeira</h3><p>Para cortes em madeira, MDF, compensado, PVC e até alguns metais leves. A tico-tico (ou serra sabre) é mais versátil para curvas, recortes e trabalho em espaços apertados — ideal para quem faz marcenaria ocasional. A serra circular é superior para cortes longos, retos e em madeiras mais grossas. Se você for escolher apenas uma, opte pela tico-tico pela versatilidade. Marcas como Bosch, Skil e Makita têm ótimas opções nessas categorias.</p><h3>4. Esmerilhadeira angular (grinder) — indispensável em obras</h3><p>Para cortar metal, cerâmica, pedra e concreto. Também serve para lixar e polir superfícies com os discos adequados. Modelos de 4.5" (115mm) são suficientes para uso doméstico e ocasional. Sempre utilize proteção ocular e luvas — é a ferramenta que mais exige equipamento de segurança. Dewalt, Bosch e Vonder têm opções excelentes na faixa de R$ 150-400.</p><h3>5. Pistola de silicone — a mais subestimada do kit</h3><p>A pistola de silicone correta e de qualidade aplica selantes, rejuntes e adesivos de forma uniforme e controlada, sem desperdício e sem sujeira. Essencial para vedar banheiros, rejuntar janelas, selar frestas em torno de tubulações e fixar rodapés. Modelos elétricos a bateria são mais práticos para trabalhos longos. O custo é baixo (R$ 30-120) e o resultado é profissional quando bem aplicado.</p><h3>6. Soprador térmico — mais versátil do que parece</h3><p>Remove tinta velha com facilidade (sem lixar), dobra e molda tubos de PVC e mangueiras, encolhe embalagens plásticas, descongela fechaduras e canos, seca rejunte ou verniz acelerado, e até remove adesivos de superfícies. Um dos equipamentos com melhor custo-benefício do kit — a partir de R$ 80 por modelos simples de 2.000W.</p><h3>7. Detector de tensão e vigas (scanner de parede)</h3><p>Antes de furar qualquer parede, é indispensável saber o que tem dentro. O detector multifunção identifica fiação elétrica energizada, tubulações de metal e vigas de madeira ou concreto. Evita choques elétricos, rompimento de encanamentos e fissuras estruturais. Modelos básicos a partir de R$ 60. É a ferramenta que mais vezes vai fazer você se arrepender de não ter comprado antes.</p><h2>A ordem inteligente de montagem do kit</h2><p>Se você está começando do zero, não compre tudo de uma vez. A ordem recomendada pela Equipe TeckHome: (1) Parafusadeira + kit de brocas, (2) Nível a laser, (3) Pistola de silicone + kit de selantes, (4) Detector de parede, (5) Tico-tico ou serra circular, (6) Soprador térmico, (7) Esmerilhadeira. Cada compra já entrega valor imediato antes da próxima.</p><h2>Onde comprar com segurança e garantia</h2><p>Ferramentas elétricas compradas de fornecedores sem procedência podem apresentar riscos de segurança sérios — motores subdimensionados, fiação inadequada e sem garantia real. Use os links verificados e curados pela Equipe TeckHome para garantir produtos originais, com nota fiscal e suporte de pós-venda adequado.</p>`
    },
    'guia-cama-mesa': {
      slug: 'guia-cama-mesa',
      title: 'Cama e Mesa em 2026: como montar um quarto confortável e elegante sem gastar uma fortuna',
      category: 'Cama e Mesa', categoryIcon: '🛏️', categoryId: 'cama-mesa',
      image: 'https://images.unsplash.com/photo-1540518614846-7eded433c457?w=1200&q=80',
      readTime: '8 min',
      keywords: 'jogo de cama qualidade, travesseiro ideal, colchão custo-benefício, roupa de cama 2026',
      excerpt: 'A qualidade do seu sono depende diretamente da qualidade da sua cama — e não é necessário gastar uma fortuna para dormir muito bem. Descubra os critérios que realmente fazem diferença.',
      content: `<h2>Por que o seu sono pode estar sendo sabotado pela sua cama</h2><p>A maioria das pessoas dorme em colchões, travesseiros e roupas de cama inadequados sem perceber — até que os sintomas aparecem: dores nas costas ao acordar, sensação de cansaço mesmo após 8 horas de sono, rinite noturna sem causa aparente e temperatura que nunca parece certa. A boa notícia é que resolver esses problemas não exige grande investimento — exige escolha informada.</p><h2>O colchão: o item mais importante da sua cama</h2><p>O colchão ideal depende principalmente do seu peso, da posição em que você dorme e se divide a cama com alguém. Os principais tipos disponíveis no mercado brasileiro são:</p><h3>Espuma D33-D45 (convencional)</h3><p>A opção mais comum e econômica (R$ 300-800 em tamanho casal). A densidade D33 é mínima para adultos — prefira D40 ou D45 para maior durabilidade e suporte. Duração esperada: 8-10 anos com uso correto.</p><h3>Molas ensacadas (pocket)</h3><p>Cada mola é independente, o que reduz significativamente a transferência de movimento — ideal para casais com horários diferentes. Excelente suporte ortopédico. Preço: R$ 1.200-4.000. Durabilidade: 12-15 anos.</p><h3>Espuma viscoelástica (memory foam)</h3><p>Molda ao corpo e distribui o peso uniformemente, aliviando pressão nos pontos críticos (quadril, ombros). Excelente para quem tem dores crônicas nas costas. Tende a reter calor — verifique se o modelo tem cobertura em gel ou tecido termorregulador.</p><h3>Híbrido (molas + espuma)</h3><p>O melhor dos dois mundos: suporte das molas com conforto da espuma. Geralmente a melhor opção para uso geral, mas com preço mais elevado (R$ 1.800-5.000 no tamanho casal).</p><h2>O travesseiro: mais impacto do que você imagina</h2><p>O travesseiro errado causa dores de cabeça, tensão no pescoço e acordar com a mandíbula contraída. A escolha correta depende da sua posição de dormir:</p><ul><li><strong>Deitado de lado:</strong> Travesseiro firme e alto (10-14cm) para manter o alinhamento da coluna cervical. Preenchimento em látex ou fibra siliconada de alta densidade.</li><li><strong>Deitado de barriga para cima:</strong> Travesseiro médio (8-12cm), menos firme. O pescoço deve permanecer em linha reta com a coluna.</li><li><strong>Barriga para baixo:</strong> Posição não recomendada para a coluna, mas se for dormir assim, use travesseiro muito baixo ou nenhum.</li></ul><p>Travesseiros de látex natural ou viscoelástico têm vida útil de 3-5 anos com higienização adequada. Travesseiros de fibra convencional precisam ser trocados a cada 1-2 anos — ficam amarelados e perdem a elasticidade, tornando-se criadouros de ácaros.</p><h2>Jogo de cama: o que fazer a diferença além da estética</h2><p>O fio (thread count) é frequentemente usado como medida de qualidade, mas é enganoso. Um jogo com 400 fios de algodão de alta qualidade é superior a um com 1.000 fios de algodão ruim. O que realmente importa é a composição do tecido:</p><ul><li><strong>Algodão percal (200+ fios):</strong> Fresco, durável, levemente rígido inicialmente mas que amacia com as lavagens. Ideal para climas quentes. Durabilidade excelente.</li><li><strong>Algodão acetinado ou piquet:</strong> Macio desde a primeira lavagem, toque luxuoso. Levemente mais quente que o percal.</li><li><strong>Microfibra:</strong> Econômica (R$ 50-150), fácil manutenção, seca rápido. Pode ser sintética demais para peles sensíveis e climas muito quentes.</li><li><strong>Linho:</strong> Premium, muito fresco, ideal para verão. Textura rústica que muitos apreciam.</li></ul><h2>Cuidados que prolongam a vida útil de tudo</h2><p>Lavar roupas de cama em água morna (40°C) uma vez por semana é o ideal. Jamais deixe o colchão sem protetor — o protetor impermeável evita manchas e a penetração de suor que deteriora a espuma internamente. Vire o colchão a cada 3 meses (ou gire 180°, se for o tipo pillow top). Para travesseiros de látex e memory foam, lave apenas a fronha e faça higienização a seco periodicamente.</p><h2>Nossa recomendação custo-benefício</h2><p>Para a maioria das pessoas: colchão de espuma D45 ou molas pocket de marca nacional confiável (Ortobom, Castor, Plumatex), jogo de cama em percal de algodão 200 fios ou mais, e travesseiro de látex natural ou fibra siliconada de alta densidade. Confira os produtos selecionados pela Equipe TeckHome com análise de custo-benefício e links verificados de fornecedores confiáveis.</p>`
    },
    'guia-jardim': {
      slug: 'guia-jardim',
      title: 'Jardim em casa: como começar do zero e criar um espaço verde bonito mesmo sem experiência',
      category: 'Jardim', categoryIcon: '🌿', categoryId: 'jardim',
      image: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=1200&q=80',
      readTime: '9 min',
      keywords: 'jardim em casa para iniciantes, como cuidar de plantas, horta em apartamento 2026, ferramentas para jardim',
      excerpt: 'Criar um jardim bonito e saudável não exige conhecimento avançado em botânica — exige apenas as ferramentas certas, as plantas certas para o seu espaço e alguns hábitos simples.',
      content: `<h2>Por que um jardim em casa muda muito mais do que a estética</h2><p>Pesquisas de psicologia ambiental mostram que contato visual e tátil com plantas reduz o cortisol (hormônio do estresse) em até 15% após apenas 5 minutos de interação. Jardins em casa melhora a qualidade do ar interno (algumas plantas filtram compostos orgânicos voláteis), aumentam a umidade natural do ambiente em climas secos e criam uma sensação de bem-estar que nenhuma decoração artificial replica. E o melhor: você não precisa de jardim externo para começar.</p><h2>Diagnóstico antes de comprar qualquer planta</h2><p>O erro número um de quem começa a jardinar é comprar plantas antes de entender o ambiente disponível. Responda estas perguntas antes de gastar qualquer real:</p><ul><li><strong>Quanto sol o espaço recebe?</strong> Pleno sol (6+ horas diretas), meia sombra (2-4h), sombra (menos de 2h). Isso determina absolutamente quais plantas vão sobreviver.</li><li><strong>Qual é o clima da sua cidade?</strong> Temperatura mínima no inverno, umidade relativa do ar, chuvas frequentes ou clima seco.</li><li><strong>Você tem espaço externo ou só interno?</strong> Varanda, sacada, quintal, terraço — ou apenas janelas e ambientes internos.</li><li><strong>Quanto tempo pode dedicar?</strong> 5 minutos por dia ou 30 minutos por semana? Algumas plantas exigem atenção diária; outras sobrevivem ao abandono.</li></ul><h2>As 10 plantas mais fáceis para iniciantes</h2><h3>Para ambientes internos com pouca luz</h3><ul><li><strong>Zamioculca:</strong> Sobrevive com iluminação artificial, rega mensal e temperatura até 10°C. Praticamente indestrutível.</li><li><strong>Pothos (jiboia):</strong> Cresce em qualquer condição, purifica o ar, pode viver em água. Ideal para pendentes e prateleiras.</li><li><strong>Língua de sogra (sansevieria):</strong> Tolera seca prolongada, funciona em luz baixa, filtra formaldeído e benzeno do ar.</li><li><strong>Dracena:</strong> Elegante, tolerante à falta de luz e ao esquecimento de rega.</li></ul><h3>Para varandas e ambientes com meia sombra</h3><ul><li><strong>Samambaia:</strong> Frondosa, fresca, exige rega regular mas tolera sombra. Cria sensação de floresta.</li><li><strong>Begônia:</strong> Flores coloridas durante todo o ano com poucos cuidados. Prefere luz indireta.</li><li><strong>Impatiens:</strong> Florescimento intenso em sombra, ideal para vasos.</li></ul><h3>Para áreas de sol pleno</h3><ul><li><strong>Suculentas e cactos:</strong> Rega quinzenal, sol direto, vasos com boa drenagem. Perfeitas para quem viaja frequentemente.</li><li><strong>Lavanda:</strong> Perfumada, repele insetos, floresce no verão. Exige sol direto e solo bem drenado.</li><li><strong>Alecrim:</strong> Tempero e jardim ao mesmo tempo. Resistente, aromático, bonito.</li></ul><h2>Ferramentas essenciais para cuidar bem do jardim</h2><p>Você não precisa de um galpão cheio de ferramentas para ter um jardim bonito. O kit mínimo para iniciantes:</p><ul><li><strong>Regador de bico fino:</strong> Para molhar a terra sem danificar folhas delicadas. Modelos de 1,5-2L são práticos para uso interno.</li><li><strong>Pá pequena de jardim e rastelo de mão:</strong> Para revolver a terra, misturar substratos e plantar.</li><li><strong>Tesoura de poda:</strong> Lâminas afiadas de aço inox. Cortes limpos evitam doenças nas plantas. Modelos da Tramontina e Vonder são excelentes no custo-benefício.</li><li><strong>Luvas de jardim:</strong> Protegem das espinhas, terra e fungos. Modelos de neoprene são mais duráveis e laváveis.</li><li><strong>Borrifador:</strong> Para umidificar folhagens e combater pragas leves com água. Essencial para samambaias e orquídeas.</li></ul><h2>Solo e substrato: o fator mais negligenciado</h2><p>Plantas morrem mais frequentemente por problemas de solo do que por falta de rega. Terra preta de jardim pura compacta com o tempo e afoga as raízes. Use sempre substrato específico para o tipo de planta:</p><ul><li><strong>Suculentas e cactos:</strong> 50% substrato universal + 50% areia grossa ou perlita</li><li><strong>Plantas tropicais (pothos, dracena):</strong> Substrato universal com adição de casca de pinus</li><li><strong>Orquídeas:</strong> Substrato específico para orquídeas — nunca terra comum</li><li><strong>Hortas:</strong> Substrato para hortaliças ou húmus de minhoca + terra vegetal</li></ul><h2>Horta em apartamento: é possível e prático</h2><p>Ervas aromáticas são a melhor estreia: manjericão, salsinha, cebolinha, tomilho e alecrim crescem em vasos simples na janela com sol de manhã. Colhidos frescos, têm sabor incomparável em relação ao comprado em supermercado. Para quem tem varanda: alface, rúcula, tomate cereja e pimentão dão muito bem em vasos de 5-10L.</p><h2>Nossa recomendação para começar hoje</h2><p>Comece com 3 plantas: uma suculenta (baixa manutenção), uma pothos (ambiente interno) e uma erva aromática (para a cozinha). Com esse trio, você aprende sobre rega, substrato e luz sem risco de frustração. À medida que ganhar confiança, expanda gradualmente. Confira os kits de ferramentas de jardim e vasos selecionados pela Equipe TeckHome com os melhores preços verificados.</p>`
    },
    'guia-ventilacao': {
      slug: 'guia-ventilacao',
      title: 'Ventilador ou ar-condicionado? O guia completo sobre ventilação doméstica em 2026',
      category: 'Ventilação', categoryIcon: '💨', categoryId: 'ventilacao',
      image: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&q=80',
      readTime: '7 min',
      keywords: 'ventilador de teto custo-benefício, ventilador vs ar condicionado, climatizador evaporativo 2026, melhor ventilador',
      excerpt: 'Em um Brasil onde o calor bate 35°C em grande parte do país por meses seguidos, escolher o sistema de ventilação correto pode significar economia de até R$ 150 por mês na conta de luz.',
      content: `<h2>A questão econômica que ninguém calcula direito</h2><p>Um ar-condicionado split de 9.000 BTU consome em média 900W por hora de funcionamento. Um ventilador de teto de boa qualidade consome entre 50W e 80W. Se você usa o aparelho 8 horas por dia durante 30 dias, a diferença de consumo chega a 198 kWh mensais — o que representa cerca de R$ 178 a menos na conta de luz (considerando a tarifa média nacional de R$ 0,90/kWh). Isso não significa que o ventilador substitui o ar-condicionado em climas extremos — mas entender quando usar cada um é uma decisão financeiramente inteligente.</p><h2>Os 4 tipos de ventilação disponíveis no mercado</h2><h3>1. Ventilador de teto — o melhor para uso diário</h3><p>O ventilador de teto distribui o ar por toda a área do cômodo de forma uniforme e silenciosa. Modelos modernos operam entre 30 e 55 dB (quase inaudíveis), têm controle remoto com timer e podem ser reversíveis — no inverno, o sentido invertido distribui o calor acumulado no teto para o ambiente, reduzindo a necessidade de aquecimento.</p><p>O que avaliar na compra: número de pás (3 pás para quartos médios, 5 pás para maior eficiência em cômodos grandes), diâmetro das pás (42" para até 16m², 52" para até 30m², 60"+ para áreas maiores), potência do motor (50W-85W para uso residencial) e certificação Procel. Marcas confiáveis: Arno, Venti-Delta, Ventisol e Ventax.</p><h3>2. Ventilador de coluna (tower fan)</h3><p>Ocupa pouco espaço no piso, cobre grande área vertical de ventilação, é fácil de mover entre cômodos. Ideal para quartos pequenos, escritórios e espaços alugados onde não se pode instalar ventilador de teto. Desvantagem: mais barulhento que os de teto e distribui o ar em uma faixa mais estreita.</p><h3>3. Climatizador evaporativo — ventilação + umidificação</h3><p>Uma solução interessante e sub-avaliada no Brasil. O climatizador evaporativo passa o ar por uma cortina de água, resfriando-o por evaporação e umidificando simultaneamente o ambiente. Funciona muito bem em climas secos como o do interior paulista, Minas Gerais, Goiás e Norte do Brasil. Consumo: 150-250W — muito menor que o ar-condicionado, ligeiramente maior que o ventilador. Desvantagem: não funciona bem em climas já úmidos (litoral, RJ, SP capital no verão). Exige abastecimento regular de água no reservatório.</p><h3>4. Ventilador portátil de mesa e parede</h3><p>Para uso localizado e pontual: escritório, cozinha, banheiro. Barato (R$ 60-200), fácil de instalar e mover. Não substitui a ventilação de ambiente, mas complementa muito bem. Modelos de parede são excelentes em garagens, oficinas e cozinhas industriais.</p><h2>Ventilador de teto com luz integrada — vale a pena?</h2><p>Os modelos com kit de iluminação LED integrado são uma solução elegante para quem quer aproveitar o ponto elétrico do teto para duas funções. A iluminação geralmente vem em temperatura de cor ajustável (luz quente/fria) e potência adequada para quartos de até 20m². O custo extra é de R$ 80-250 dependendo do modelo — vale para quem reformou recentemente ou está montando um quarto novo.</p><h2>Como instalar com segurança</h2><p>Ventiladores de teto exigem instalação em caixa elétrica de teto de 4"x4" específica para ventilador (suporta peso e vibração). Nunca instale em caixa comum de tomada ou interruptor. Para cômodos com pé-direito baixo (até 2,60m), use suporte de encosto — modelos sem hastes que ficam rentes ao teto. Para pé-direito alto (3m+), use hastes de extensão para que as pás fiquem na faixa de 2,10m-2,40m do piso, que é a altura ideal de circulação de ar.</p><h2>A combinação inteligente: ventilador + ar-condicionado</h2><p>Aqui está o segredo que pouca gente usa: ventilador de teto e ar-condicionado juntos. Com o ventilador em funcionamento, é possível configurar o ar-condicionado 2-3°C acima da temperatura que você normalmente precisaria para se sentir confortável. Isso porque o ventilador distribui o ar frio uniformemente e cria a sensação de frescor pelo efeito wind-chill. Resultado: a mesma sensação térmica com consumo até 30% menor do ar-condicionado.</p><h2>Nossa recomendação final</h2><p>Para quem quer conforto no custo-benefício: <strong>ventilador de teto de 52" com motor de 65W+ e controle remoto</strong>, das marcas Arno ou Ventisol. Para climas secos: <strong>climatizador evaporativo de 20-30L</strong> como opção intermediária entre ventilador e ar-condicionado. Para uso intenso no calor extremo: a combinação de ventilador de teto + ar-condicionado no modo econômico é a mais eficiente de todas. Confira os modelos selecionados e verificados pela Equipe TeckHome com análise completa de custo-benefício.</p>`
    }
  }

  // Tenta buscar no KV (artigos criados pelo admin)
  const tryKv = async () => {
    try {
      const kv = c.env?.ARTICLES_KV
      if (!kv) return null
      const list = await kv.list({ prefix: 'article_' })
      for (const k of list.keys) {
        const val = await kv.get(k.name)
        if (val) {
          const art = JSON.parse(val)
          if (art.slug === slug) return art
        }
      }
    } catch { }
    return null
  }

  const article = staticArticlesFull[slug] || await tryKv()
  if (!article) return c.redirect('/')

  return c.html(articlePage(article))
})

// === HTML PAGES ===

function maintenancePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>TeckHome Store — Em Manutenção</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { font-family: 'Inter', system-ui, sans-serif; }
    @keyframes pulse2 { 0%,100%{opacity:1} 50%{opacity:.5} }
    .pulse { animation: pulse2 2s infinite; }
    @keyframes spin { to{transform:rotate(360deg)} }
    .spin { animation: spin 3s linear infinite; }
    @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)} }
    .float { animation: float 3s ease-in-out infinite; }
  </style>
</head>
<body class="bg-gradient-to-br from-indigo-950 via-indigo-900 to-purple-900 min-h-screen flex items-center justify-center p-4">
  <div class="text-center max-w-lg mx-auto">
    <!-- Logo flutuando -->
    <div class="float mb-8">
      <img src="/static/logo.png" alt="TeckHome" class="w-24 h-24 rounded-3xl mx-auto shadow-2xl shadow-indigo-500/30 object-cover">
    </div>
    <!-- Ícone de manutenção girando -->
    <div class="w-20 h-20 rounded-full border-4 border-indigo-400/30 border-t-indigo-400 spin mx-auto mb-8"></div>
    <!-- Título -->
    <h1 class="text-3xl font-black text-white mb-3">Site em Manutenção</h1>
    <p class="text-indigo-200 text-lg mb-2 font-medium">Estamos melhorando sua experiência.</p>
    <p class="text-indigo-300/70 text-sm mb-10">Nossa equipe está trabalhando para trazer novidades. Voltamos em breve!</p>
    <!-- Status -->
    <div class="bg-white/10 backdrop-blur-sm rounded-2xl p-5 border border-white/20 mb-8">
      <div class="flex items-center justify-center gap-3 mb-4">
        <div class="w-2.5 h-2.5 rounded-full bg-yellow-400 pulse"></div>
        <span class="text-white font-bold text-sm">Manutenção em andamento</span>
      </div>
      <div class="space-y-2">
        <div class="flex items-center gap-2 text-indigo-200 text-xs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Site seguro e protegido
        </div>
        <div class="flex items-center gap-2 text-indigo-200 text-xs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Previsão: retorno em breve
        </div>
      </div>
    </div>
    <!-- Contato -->
    <p class="text-indigo-400 text-xs">
      Dúvidas? <a href="mailto:contato@teckhomestore.com" class="text-indigo-300 hover:text-white underline transition-colors">contato@teckhomestore.com</a>
    </p>
    <p class="text-indigo-600 text-xs mt-6">© 2026 TeckHome Store</p>
  </div>
</body>
</html>`
}

function homePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>TeckHome Store — Reviews, Comparativos e Melhores Produtos para sua Casa</title>
  <meta name="description" content="TeckHome Store: reviews honestos, comparativos e recomendações dos melhores produtos de tecnologia, eletrodomésticos, refrigeração, ventilação e jardim. Descubra antes de comprar!">
  <meta name="keywords" content="reviews de produtos, melhores eletrodomésticos, tecnologia para casa, comparativo de produtos, eletrônicos, refrigeração, ventilação, jardim, TeckHome Store">
  <meta name="robots" content="index, follow">
  <meta name="author" content="Equipe TeckHome">
  <link rel="canonical" href="https://teckhomestore.com/">
  <meta property="og:title" content="TeckHome Store — Descubra antes de comprar">
  <meta property="og:description" content="Reviews honestos e recomendações dos melhores produtos para sua casa e tecnologia. Análises imparciais da Equipe TeckHome.">
  <meta property="og:image" content="https://teckhomestore.com/static/logo.png">
  <meta property="og:url" content="https://teckhomestore.com">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="TeckHome Store — Reviews e Comparativos">
  <meta name="twitter:description" content="Descubra os melhores produtos antes de comprar. Reviews imparciais da Equipe TeckHome.">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","@id":"https://teckhomestore.com/#website","name":"TeckHome Store","url":"https://teckhomestore.com","description":"Portal brasileiro de reviews honestos, comparativos e recomendações de produtos de tecnologia, eletrodomésticos e utilidades para o lar","inLanguage":"pt-BR","potentialAction":{"@type":"SearchAction","target":{"@type":"EntryPoint","urlTemplate":"https://teckhomestore.com/?q={search_term_string}"},"query-input":"required name=search_term_string"}},{"@type":"Organization","@id":"https://teckhomestore.com/#organization","name":"TeckHome Store","url":"https://teckhomestore.com","logo":{"@type":"ImageObject","url":"https://teckhomestore.com/static/logo.png","width":512,"height":512},"description":"Portal de reviews, comparativos e recomendações de produtos para o lar e tecnologia","contactPoint":{"@type":"ContactPoint","contactType":"customer service","email":"contato@teckhomestore.com","availableLanguage":"Portuguese"}},{"@type":"WebPage","@id":"https://teckhomestore.com/#webpage","url":"https://teckhomestore.com","name":"TeckHome Store — Reviews, Comparativos e Melhores Produtos para sua Casa","isPartOf":{"@id":"https://teckhomestore.com/#website"},"about":{"@id":"https://teckhomestore.com/#organization"},"description":"Reviews honestos, comparativos imparciais e recomendações dos melhores produtos de tecnologia, eletrodomésticos e utilidades para sua casa."}]}</script>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; box-sizing: border-box; }

    /* ===== HERO ===== */
    .hero-section { position: relative; background: #0b0920; overflow: hidden; min-height: 100vh; display: flex; align-items: center; }
    .hero-bg-img { position: absolute; top:0; left:0; right:0; bottom:0; width:100%; height:100%; object-fit:cover; object-position:center center; opacity:0.32; transform:none !important; animation:none !important; transition:none !important; pointer-events:none; user-select:none; z-index:1; display:block; }
    .hero-overlay { position:absolute; inset:0; z-index:2; background:linear-gradient(160deg,rgba(11,9,32,0.95) 0%,rgba(21,18,60,0.88) 35%,rgba(38,33,90,0.82) 65%,rgba(11,9,32,0.97) 100%); pointer-events:none; }
    .hero-content { position:relative; z-index:10; width:100%; }
    .hero-eyebrow { display:inline-flex; align-items:center; gap:8px; background:rgba(99,102,241,0.18); border:1px solid rgba(99,102,241,0.35); color:#a5b4fc; font-size:0.72rem; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; padding:6px 16px; border-radius:100px; margin-bottom:24px; backdrop-filter:blur(8px); }
    .hero-title { font-size:clamp(2.8rem,8vw,6rem); font-weight:900; line-height:1; letter-spacing:-0.03em; }
    .hero-subtitle { font-size:clamp(1rem,2.5vw,1.25rem); color:rgba(199,210,254,0.88); line-height:1.7; max-width:600px; }
    .hero-btn-primary { display:inline-flex; align-items:center; gap:10px; background:linear-gradient(135deg,#6366f1,#4f46e5); color:#fff; font-weight:800; font-size:0.95rem; padding:14px 32px; border-radius:14px; border:none; cursor:pointer; text-decoration:none; transition:all 0.3s cubic-bezier(.4,0,.2,1); box-shadow:0 8px 32px rgba(99,102,241,0.45); }
    .hero-btn-primary:hover { transform:translateY(-2px); box-shadow:0 16px 40px rgba(99,102,241,0.55); background:linear-gradient(135deg,#818cf8,#6366f1); }
    .hero-btn-secondary { display:inline-flex; align-items:center; gap:10px; background:rgba(255,255,255,0.08); color:#fff; font-weight:700; font-size:0.95rem; padding:14px 32px; border-radius:14px; border:1px solid rgba(255,255,255,0.22); cursor:pointer; text-decoration:none; transition:all 0.3s; backdrop-filter:blur(8px); }
    .hero-btn-secondary:hover { background:rgba(255,255,255,0.16); border-color:rgba(255,255,255,0.38); transform:translateY(-2px); }

    /* ===== NAVBAR ===== */
    .nav-link { position:relative; padding-bottom:2px; }
    .nav-link::after { content:''; position:absolute; bottom:-2px; left:0; width:0; height:2px; background:linear-gradient(90deg,#6366f1,#818cf8); border-radius:2px; transition:width 0.3s ease; }
    .nav-link:hover::after { width:100%; }
    .navbar-glass { background:rgba(255,255,255,0.97); backdrop-filter:blur(20px); border-bottom:1px solid rgba(99,102,241,0.1); box-shadow:0 1px 24px rgba(99,102,241,0.07); }

    /* ===== SECTION HEADERS ===== */
    .section-label { display:inline-flex; align-items:center; gap:6px; background:linear-gradient(135deg,#eef2ff,#e0e7ff); color:#4f46e5; font-size:0.7rem; font-weight:800; letter-spacing:0.14em; text-transform:uppercase; padding:5px 14px; border-radius:100px; border:1px solid #c7d2fe; margin-bottom:12px; }
    .section-title { font-size:clamp(1.6rem,4vw,2.4rem); font-weight:900; color:#111827; letter-spacing:-0.02em; line-height:1.15; }
    .section-divider { width:48px; height:4px; background:linear-gradient(90deg,#6366f1,#818cf8); border-radius:4px; margin-top:12px; }

    /* ===== CARDS ===== */
    .card-hover { transition:all 0.32s cubic-bezier(.4,0,.2,1); }
    .card-hover:hover { transform:translateY(-8px); box-shadow:0 24px 56px rgba(99,102,241,0.16); }
    .shimmer { background:linear-gradient(90deg,#f3f4f6 25%,#e9eaec 50%,#f3f4f6 75%); background-size:200% 100%; animation:shimmer 1.5s infinite; border-radius:16px; }
    @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
    .featured-badge { background:linear-gradient(135deg,#f59e0b,#ef4444); }

    /* ===== CATEGORY CARDS ===== */
    .category-card { position:relative; overflow:hidden; }
    .category-card::before { content:''; position:absolute; inset:0; background:linear-gradient(135deg,transparent 60%,rgba(99,102,241,0.04) 100%); opacity:0; transition:opacity 0.3s; border-radius:inherit; }
    .category-card:hover::before { opacity:1; }
    .category-card:hover .cat-icon-wrap { transform:scale(1.08); }
    .cat-icon-wrap { transition:transform 0.3s cubic-bezier(.4,0,.2,1); }

    /* ===== BLOG CARDS ===== */
    .blog-card { transition:all 0.3s cubic-bezier(.4,0,.2,1); }
    .blog-card:hover { transform:translateY(-6px); box-shadow:0 20px 48px rgba(99,102,241,0.14); }
    .blog-card-img { overflow:hidden; border-radius:12px 12px 0 0; }
    .blog-card-img img { transition:transform 0.5s cubic-bezier(.4,0,.2,1); }
    .blog-card:hover .blog-card-img img { transform:scale(1.05); }

    /* ===== PRODUCT CARDS ===== */
    .editorial-footer { background:linear-gradient(135deg,#f8faff,#eef2ff); border-top:1px solid #e0e7ff; }
    .editorial-footer:hover { background:linear-gradient(135deg,#eef2ff,#e0e7ff); }
    .trust-badge { background:linear-gradient(135deg,#f0fdf4,#dcfce7); border:1px solid #bbf7d0; }
    .product-card-img { overflow:hidden; }
    .product-card-img img { transition:transform 0.4s cubic-bezier(.4,0,.2,1); }
    .card-hover:hover .product-card-img img { transform:scale(1.04); }

    /* ===== STAT COUNTER ===== */
    .stat-counter { background:linear-gradient(135deg,rgba(255,255,255,0.13),rgba(255,255,255,0.06)); backdrop-filter:blur(12px); border:1px solid rgba(255,255,255,0.18); transition:all 0.3s; }
    .stat-counter:hover { background:linear-gradient(135deg,rgba(255,255,255,0.2),rgba(255,255,255,0.1)); border-color:rgba(255,255,255,0.3); transform:translateY(-2px); }

    /* ===== BUSCA ===== */
    .search-box { transition:all 0.3s; }
    .search-box:focus { box-shadow:0 0 0 4px rgba(99,102,241,0.2); border-color:#6366f1 !important; }

    /* ===== ANIMAÇÕES ===== */
    @keyframes gradientMove { 0%{background-position:0% 0} 100%{background-position:200% 0} }
    @keyframes fadeInUp { from{opacity:0;transform:translateY(28px)} to{opacity:1;transform:translateY(0)} }
    @keyframes fadeInDown { from{opacity:0;transform:translateY(-16px)} to{opacity:1;transform:translateY(0)} }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    .fade-in-up { animation:fadeInUp 0.7s ease forwards; }
    .fade-in-up-2 { animation:fadeInUp 0.7s 0.15s ease both; }
    .fade-in-up-3 { animation:fadeInUp 0.7s 0.3s ease both; }
    .fade-in-up-4 { animation:fadeInUp 0.7s 0.45s ease both; }

    /* ===== SCROLLBAR ===== */
    ::-webkit-scrollbar { width:6px; }
    ::-webkit-scrollbar-track { background:#f1f1f1; }
    ::-webkit-scrollbar-thumb { background:linear-gradient(180deg,#6366f1,#818cf8); border-radius:6px; }

    /* ===== TRUST STRIP ===== */
    .trust-strip { background:linear-gradient(90deg,#1e1b4b,#312e81,#1e3a5f); }

    /* ===== BUTTONS ===== */
    .btn-primary { display:inline-flex; align-items:center; gap:8px; background:linear-gradient(135deg,#6366f1,#4f46e5); color:#fff; font-weight:700; padding:11px 24px; border-radius:12px; border:none; cursor:pointer; text-decoration:none; transition:all 0.3s; box-shadow:0 4px 16px rgba(99,102,241,0.35); font-size:0.875rem; }
    .btn-primary:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(99,102,241,0.45); }
    .btn-outline { display:inline-flex; align-items:center; gap:8px; background:transparent; color:#6366f1; font-weight:700; padding:10px 24px; border-radius:12px; border:2px solid #6366f1; cursor:pointer; text-decoration:none; transition:all 0.3s; font-size:0.875rem; }
    .btn-outline:hover { background:#6366f1; color:#fff; transform:translateY(-2px); }

    /* ===== FONTAWESOME ===== */
    .emoji-icon { font-style:normal; font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif !important; }
    i.fas, i.fa, i.far { font-family:'Font Awesome 6 Free' !important; font-weight:900 !important; font-style:normal !important; }
    i.fab { font-family:'Font Awesome 6 Brands' !important; font-weight:400 !important; font-style:normal !important; }
    i.fas.text-indigo-500 { color:#6366f1 !important; }
    i.fas.text-indigo-400 { color:#818cf8 !important; }
    i.fas.text-white { color:#ffffff !important; }
    i.fas.text-xs { font-size:0.75rem !important; }

    /* ===== MOBILE IMPROVEMENTS ===== */
    @media (max-width: 640px) {
      .hero-title { font-size: clamp(2.2rem, 10vw, 3.5rem); }
      .section-title { font-size: clamp(1.4rem, 6vw, 2rem); }
      .hero-btn-primary, .hero-btn-secondary { width: 100%; justify-content: center; font-size: 0.9rem; padding: 13px 20px; }
      .stat-counter { padding: 10px 8px; }
    }
    /* ===== FAQ ACCORDION ===== */
    .faq-item { border-bottom: 1px solid #e5e7eb; }
    .faq-question { cursor: pointer; user-select: none; }
    .faq-answer { max-height: 0; overflow: hidden; transition: max-height 0.35s ease, padding 0.25s ease; }
    .faq-answer.open { max-height: 400px; }
    .faq-icon { transition: transform 0.3s ease; }
    .faq-icon.open { transform: rotate(45deg); }
    /* ===== RATING BARS ===== */
    .rating-bar-fill { transition: width 0.8s cubic-bezier(.4,0,.2,1); }
    /* ===== NEWSLETTER ===== */
    .newsletter-input:focus { box-shadow: 0 0 0 3px rgba(99,102,241,0.25); outline: none; }
    /* ===== METHODOLOGY STEPS ===== */
    .method-step { counter-increment: steps; }
    .method-step::before { content: counter(steps); }
    /* ===== BENEFIT CARD ===== */
    .benefit-card { transition: all 0.3s cubic-bezier(.4,0,.2,1); }
    .benefit-card:hover { transform: translateY(-4px); box-shadow: 0 16px 40px rgba(99,102,241,0.14); }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- NAVBAR -->
  <nav class="navbar-glass sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-3 group">
          <div class="relative">
            <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md group-hover:shadow-indigo-200 transition-shadow">
            <div class="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-400 rounded-full border-2 border-white"></div>
          </div>
          <div>
            <span class="text-lg font-black text-gray-900 tracking-tight">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5 font-medium">Descubra antes de comprar</span>
          </div>
        </a>
        <div class="hidden md:flex items-center gap-7">
          <a href="/" class="nav-link text-sm font-semibold text-gray-600 hover:text-indigo-600 transition-colors">Início</a>
          <a href="#destaques" class="nav-link text-sm font-semibold text-gray-600 hover:text-indigo-600 transition-colors">Destaques</a>
          <a href="#categorias" class="nav-link text-sm font-semibold text-gray-600 hover:text-indigo-600 transition-colors">Categorias</a>
          <a href="#blog" class="nav-link text-sm font-semibold text-gray-600 hover:text-indigo-600 transition-colors">Blog</a>
          <!-- Admin: acesso discreto apenas via /admin -->
        </div>
        <button id="mobileMenuBtn" class="md:hidden p-2 rounded-xl text-gray-600 hover:bg-gray-100 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
      </div>
    </div>
    <!-- Mobile menu -->
    <div id="mobileMenu" class="hidden md:hidden border-t border-gray-100 bg-white px-4 pb-5">
      <div class="flex flex-col gap-1 pt-3">
        <a href="/" class="text-sm font-semibold text-gray-700 py-2.5 px-3 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 transition-colors">Início</a>
        <a href="#categorias" class="text-sm font-semibold text-gray-700 py-2.5 px-3 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 transition-colors">Categorias</a>
        <a href="#destaques" class="text-sm font-semibold text-gray-700 py-2.5 px-3 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 transition-colors">Destaques</a>
        <a href="#blog" class="text-sm font-semibold text-gray-700 py-2.5 px-3 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 transition-colors">Blog</a>
        <!-- Painel Admin: acessível via /admin (não exibido no menu público) -->
      </div>
    </div>
  </nav>

  <!-- HERO -->
  <section class="hero-section text-white" aria-label="Seção principal">
    <img src="/static/logo.png" alt="" aria-hidden="true" class="hero-bg-img" draggable="false">
    <div class="hero-overlay"></div>
    <!-- Orbs decorativos -->
    <div class="absolute inset-0 pointer-events-none" style="z-index:3;" aria-hidden="true">
      <div class="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full" style="background:radial-gradient(circle,rgba(99,102,241,0.18) 0%,transparent 70%);"></div>
      <div class="absolute -bottom-32 -left-32 w-[500px] h-[500px] rounded-full" style="background:radial-gradient(circle,rgba(139,92,246,0.14) 0%,transparent 70%);"></div>
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full" style="background:radial-gradient(circle,rgba(99,102,241,0.06) 0%,transparent 60%);"></div>
      <!-- Grid sutil -->
      <div class="absolute inset-0" style="opacity:0.035;background-image:linear-gradient(rgba(255,255,255,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.1) 1px,transparent 1px);background-size:72px 72px;"></div>
    </div>

    <div class="hero-content px-4 py-24 md:py-36">
      <div class="max-w-4xl mx-auto text-center">

        <!-- Eyebrow label -->
        <div class="fade-in-up flex justify-center mb-6">
          <span class="hero-eyebrow">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Portal de Reviews Verificados
          </span>
        </div>

        <!-- Título principal -->
        <div class="fade-in-up-2 mb-6">
          <h1 class="hero-title drop-shadow-2xl">
            <span class="block text-white">TECKHOME STORE</span>
            <span class="block" style="background:linear-gradient(135deg,#a5b4fc,#818cf8,#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">DESCUBRA ANTES DE COMPRAR</span>
          </h1>
        </div>

        <!-- Subtítulo -->
        <p class="hero-subtitle mx-auto mb-10 fade-in-up-3">
          Reviews inteligentes, comparativos e recomendações para sua casa e tecnologia.<br class="hidden md:block">
          <span class="text-white font-semibold">Análises imparciais para você comprar com confiança.</span>
        </p>

        <!-- Barra de busca -->
        <div class="max-w-lg mx-auto relative mb-12 fade-in-up-3">
          <input
            id="searchInput"
            type="text"
            placeholder="Buscar produtos, categorias, reviews..."
            class="search-box w-full py-4 px-6 pr-16 rounded-2xl text-gray-800 text-sm font-medium bg-white shadow-2xl outline-none border-2 border-transparent"
            oninput="handleSearch(this.value)"
          >
          <button class="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 bg-indigo-600 rounded-xl flex items-center justify-center hover:bg-indigo-700 transition-colors shadow-lg">
            <i class="fas fa-search text-white text-sm"></i>
          </button>
        </div>

        <!-- CTAs -->
        <div class="flex flex-col sm:flex-row gap-4 justify-center mb-14 fade-in-up-3">
          <a href="#blog" class="hero-btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Ver Reviews
          </a>
          <a href="#categorias" class="hero-btn-secondary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            Explorar Categorias
          </a>
        </div>

        <!-- Stats -->
        <div class="grid grid-cols-3 gap-3 max-w-xs mx-auto fade-in-up-4">
          <div class="stat-counter rounded-2xl px-3 py-4 text-center">
            <div class="text-2xl font-black text-white">7</div>
            <div class="text-indigo-300 text-xs mt-1 font-bold uppercase tracking-wider">Categorias</div>
          </div>
          <div class="stat-counter rounded-2xl px-3 py-4 text-center">
            <div class="text-2xl font-black text-white">100%</div>
            <div class="text-indigo-300 text-xs mt-1 font-bold uppercase tracking-wider">Imparcial</div>
          </div>
          <div class="stat-counter rounded-2xl px-3 py-4 text-center">
            <svg class="mx-auto mb-1" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <div class="text-indigo-300 text-xs font-bold uppercase tracking-wider">Verificado</div>
          </div>
        </div>

      </div>
    </div>

    <!-- Scroll indicator -->
    <div class="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1 opacity-50" aria-hidden="true">
      <span class="text-white text-xs font-medium tracking-widest uppercase">Explorar</span>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" class="animate-bounce"><path d="M7 10l5 5 5-5"/></svg>
    </div>
  </section>

  <!-- SEARCH RESULTS -->
  <div id="searchResults" class="hidden max-w-7xl mx-auto px-4 py-8">
    <h2 class="text-xl font-bold text-gray-800 mb-4">Resultados da busca</h2>
    <div id="searchGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"></div>
    <div id="noResults" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-search text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium">Nenhum produto encontrado</p>
    </div>
  </div>

  <!-- TRUST STRIP -->
  <div class="trust-strip py-3 px-4 overflow-hidden">
    <div class="max-w-7xl mx-auto flex items-center justify-center gap-8 text-white/80 text-xs font-semibold uppercase tracking-wider flex-wrap gap-y-2">
      <span class="flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Reviews Verificados</span>
      <span class="text-white/30">·</span>
      <span class="flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>Análises Imparciais</span>
      <span class="text-white/30">·</span>
      <span class="flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Atualizado 2026</span>
      <span class="text-white/30">·</span>
      <span class="flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Foco no Lar</span>
    </div>
  </div>

  <!-- DESTAQUES -->
  <section id="destaques" class="bg-white py-20 px-4">
    <div class="max-w-7xl mx-auto">
      <!-- Cabeçalho centralizado -->
      <div class="text-center mb-12">
        <span class="section-label mx-auto" style="display:inline-flex;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          Em Destaque
        </span>
        <h2 class="section-title" id="featuredSectionTitle">Produtos Recomendados</h2>
        <p class="text-gray-500 mt-2 text-sm max-w-lg mx-auto">Os mais bem avaliados pela nossa equipe editorial — escolhidos a dedo para você</p>
        <div class="section-divider mx-auto"></div>
      </div>
      <div id="featuredGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 justify-items-center">
        <div class="shimmer h-80 w-full"></div>
        <div class="shimmer h-80 w-full"></div>
        <div class="shimmer h-80 w-full"></div>
        <div class="shimmer h-80 w-full"></div>
      </div>
      <div id="noFeatured" class="hidden text-center py-20">
        <div class="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="1.8"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </div>
        <p class="text-gray-500 font-medium mb-3">Nenhum produto em destaque ainda</p>
      </div>
    </div>
  </section>

  <!-- COMPARATIVOS HOME -->
  <section id="comparativos-home" class="py-20 px-4" style="background:linear-gradient(135deg,#faf5ff 0%,#f3f0ff 50%,#faf5ff 100%);border-top:1px solid #e9d5ff;border-bottom:1px solid #e9d5ff;">
    <div class="max-w-7xl mx-auto">
      <!-- Header centralizado -->
      <div class="text-center mb-14">
        <span class="section-label mx-auto" style="display:inline-flex;color:#7c3aed;background:linear-gradient(135deg,#f3f0ff,#ede9fe);border-color:#c4b5fd;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15H6M15 18l3-3-3-3M9 18l-3-3 3-3"/></svg>
          Comparativo de Produtos
        </span>
        <h2 class="section-title">Qual Produto Escolher?</h2>
        <p class="text-gray-500 mt-3 max-w-xl mx-auto text-sm leading-relaxed">Nossa IA analisa pontos fortes, fracos e custo-benefício de produtos similares para você decidir com confiança</p>
        <div class="section-divider mx-auto" style="background:linear-gradient(90deg,#7c3aed,#6366f1);"></div>
      </div>
      <!-- Container de cards comparativos (carregado via JS) -->
      <div id="homeComparativosGrid" class="space-y-10">
        <!-- shimmer placeholder -->
        <div class="shimmer rounded-3xl h-72 w-full"></div>
        <div class="shimmer rounded-3xl h-72 w-full"></div>
      </div>
      <div id="homeComparativosEmpty" class="hidden text-center py-16">
        <div class="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style="background:linear-gradient(135deg,#ede9fe,#ddd6fe);">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="1.8"><path d="M18 15H6M15 18l3-3-3-3M9 18l-3-3 3-3"/></svg>
        </div>
        <p class="text-gray-500 font-medium">Nenhum comparativo disponível no momento</p>
      </div>
    </div>
  </section>

  <!-- CATEGORIAS -->
  <section id="categorias" class="px-4 py-20" style="background:linear-gradient(135deg,#f8faff 0%,#f0f4ff 50%,#f8faff 100%);">
    <div class="max-w-7xl mx-auto">
      <div class="text-center mb-14">
        <span class="section-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          Categorias
        </span>
        <h2 class="section-title">Explore por Categoria</h2>
        <p class="text-gray-500 mt-3 max-w-md mx-auto">Encontre exatamente o produto que você procura, organizado por categoria</p>
        <div class="section-divider mx-auto"></div>
      </div>
      <div id="categoriesGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
        <div class="shimmer h-36"></div>
        <div class="shimmer h-36"></div>
        <div class="shimmer h-36"></div>
        <div class="shimmer h-36"></div>
        <div class="shimmer h-36"></div>
        <div class="shimmer h-36"></div>
        <div class="shimmer h-36"></div>
      </div>
    </div>
  </section>

  <!-- BLOG -->
  <section id="blog" class="bg-white px-4 py-20">
    <div class="max-w-7xl mx-auto">
      <div class="flex flex-col md:flex-row items-start md:items-end justify-between gap-6 mb-14">
        <div>
          <span class="section-label">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Blog & Reviews
          </span>
          <h2 class="section-title">Artigos e Guias de Compra</h2>
          <p class="text-gray-500 mt-2 max-w-lg">Conteúdo editorial especializado para você tomar a melhor decisão antes de comprar.</p>
          <div class="section-divider"></div>
        </div>
        <a href="#blog" class="btn-outline hidden md:inline-flex flex-shrink-0">
          Ver todos os artigos
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
      </div>
      <div id="blogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-7">
        <div class="shimmer h-80"></div>
        <div class="shimmer h-80"></div>
        <div class="shimmer h-80"></div>
      </div>
      <div id="noBlog" class="hidden text-center py-20">
        <div class="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="1.8"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        </div>
        <p class="text-gray-500 font-medium mb-3">Nenhum artigo publicado ainda</p>
      </div>
    </div>
  </section>


  <!-- ===== COMO ANALISAMOS OS PRODUTOS ===== -->
  <section id="metodologia" class="py-20 px-4 bg-white" aria-labelledby="metodologia-title">
    <div class="max-w-6xl mx-auto">
      <div class="text-center mb-14">
        <span class="section-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          Metodologia Editorial
        </span>
        <h2 id="metodologia-title" class="section-title">Como Analisamos os Produtos</h2>
        <p class="text-gray-500 mt-3 max-w-xl mx-auto text-sm leading-relaxed">Nossa equipe segue um processo rigoroso de pesquisa e análise para garantir recomendações honestas e imparciais.</p>
        <div class="section-divider mx-auto"></div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        <!-- Passo 1 -->
        <article class="benefit-card bg-gradient-to-br from-indigo-50 to-white border border-indigo-100 rounded-2xl p-6">
          <div class="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center mb-4 shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          </div>
          <div class="text-xs font-black text-indigo-400 uppercase tracking-widest mb-1">Etapa 01</div>
          <h3 class="text-base font-black text-gray-900 mb-2">Pesquisa de Mercado</h3>
          <p class="text-gray-600 text-sm leading-relaxed">Mapeamos centenas de produtos disponíveis no mercado brasileiro antes de iniciar qualquer análise. Avaliamos preço, disponibilidade, histórico da marca e posicionamento na categoria. Só avançamos com produtos que demonstram potencial real de entrega de valor ao consumidor — descartando opções sem relevância ou histórico confiável.</p>
        </article>

        <!-- Passo 2 -->
        <article class="benefit-card bg-gradient-to-br from-blue-50 to-white border border-blue-100 rounded-2xl p-6">
          <div class="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center mb-4 shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          </div>
          <div class="text-xs font-black text-blue-400 uppercase tracking-widest mb-1">Etapa 02</div>
          <h3 class="text-base font-black text-gray-900 mb-2">Avaliações dos Consumidores</h3>
          <p class="text-gray-600 text-sm leading-relaxed">Coletamos e interpretamos avaliações de compradores verificados nos principais marketplaces do Brasil. Filtramos opiniões com base em critérios como detalhamento, consistência e utilidade real. Isso nos permite identificar padrões de satisfação e reclamações recorrentes que não aparecem nas especificações técnicas oficiais.</p>
        </article>

        <!-- Passo 3 -->
        <article class="benefit-card bg-gradient-to-br from-purple-50 to-white border border-purple-100 rounded-2xl p-6">
          <div class="w-12 h-12 bg-purple-600 rounded-2xl flex items-center justify-center mb-4 shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
          <div class="text-xs font-black text-purple-400 uppercase tracking-widest mb-1">Etapa 03</div>
          <h3 class="text-base font-black text-gray-900 mb-2">Comparação de Recursos</h3>
          <p class="text-gray-600 text-sm leading-relaxed">Colocamos o produto lado a lado com suas principais alternativas na mesma faixa de preço. Avaliamos especificações técnicas, funcionalidades exclusivas, limitações conhecidas e o que cada opção entrega na prática. O objetivo é garantir que a recomendação faça sentido não apenas de forma isolada, mas dentro do contexto do mercado atual.</p>
        </article>

        <!-- Passo 4 -->
        <article class="benefit-card bg-gradient-to-br from-emerald-50 to-white border border-emerald-100 rounded-2xl p-6">
          <div class="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center mb-4 shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div class="text-xs font-black text-emerald-400 uppercase tracking-widest mb-1">Etapa 04</div>
          <h3 class="text-base font-black text-gray-900 mb-2">Análise de Custo-Benefício</h3>
          <p class="text-gray-600 text-sm leading-relaxed">Ir além do preço de etiqueta é essencial. Analisamos o que o consumidor realmente leva para casa pelo valor investido — incluindo durabilidade esperada, condições de garantia, custo de manutenção e longevidade do produto. Um item mais barato que dura menos pode custar mais caro a longo prazo, e esse raciocínio guia nossas avaliações.</p>
        </article>

        <!-- Passo 5 -->
        <article class="benefit-card bg-gradient-to-br from-amber-50 to-white border border-amber-100 rounded-2xl p-6">
          <div class="w-12 h-12 bg-amber-500 rounded-2xl flex items-center justify-center mb-4 shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </div>
          <div class="text-xs font-black text-amber-400 uppercase tracking-widest mb-1">Etapa 05</div>
          <h3 class="text-base font-black text-gray-900 mb-2">Critérios de Qualidade</h3>
          <p class="text-gray-600 text-sm leading-relaxed">Aplicamos um conjunto fixo de critérios objetivos em todas as análises: qualidade de construção e acabamento, facilidade de uso no dia a dia, desempenho prático em condições reais, durabilidade comprovada por relatos de usuários e qualidade do suporte ao cliente. Esse padrão garante que as avaliações sejam comparáveis entre si e reprodutíveis ao longo do tempo.</p>
        </article>

        <!-- Passo 6 -->
        <article class="benefit-card bg-gradient-to-br from-sky-50 to-white border border-sky-100 rounded-2xl p-6">
          <div class="w-12 h-12 bg-sky-600 rounded-2xl flex items-center justify-center mb-4 shadow-md">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div class="text-xs font-black text-sky-400 uppercase tracking-widest mb-1">Etapa 06</div>
          <h3 class="text-base font-black text-gray-900 mb-2">Recomendação Final</h3>
          <p class="text-gray-600 text-sm leading-relaxed">Apenas produtos que atendem ao conjunto completo de critérios editoriais recebem nossa recomendação. A nota final é calculada de forma ponderada, refletindo desempenho técnico, percepção dos usuários, custo-benefício e qualidade geral. Produtos que não atingem o nível mínimo são descartados — independentemente de qualquer vínculo comercial.</p>
        </article>

      </div>

      <!-- Nota sobre imparcialidade -->
      <div class="mt-10 bg-indigo-50 border border-indigo-100 rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        </div>
        <div>
          <p class="font-bold text-indigo-900 text-sm">Compromisso com a Imparcialidade</p>
          <p class="text-indigo-700 text-xs mt-1 leading-relaxed">Este site pode conter links de afiliados. Isso não influencia nossas análises nem nossas recomendações. Nossa prioridade é sempre o benefício do consumidor, não a comissão recebida. Saiba mais em nossa <a href="/politica-de-privacidade" class="underline font-semibold">Política de Privacidade</a>.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ===== SISTEMA DE NOTAS (REUTILIZÁVEL) ===== -->
  <!-- Componente oculto — renderizado via JS quando necessário -->
  <template id="tpl-rating-system">
    <div class="th-rating-system bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
      <div class="flex items-center gap-2 mb-5">
        <div class="w-8 h-8 bg-indigo-600 rounded-xl flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </div>
        <h4 class="font-black text-gray-900 text-sm">Nota TeckHome</h4>
      </div>
      <div class="space-y-3 th-criteria"></div>
      <div class="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">Nota Final</span>
        <div class="flex items-center gap-2">
          <div class="th-stars flex gap-0.5"></div>
          <span class="th-final-score text-2xl font-black text-indigo-600"></span>
          <span class="text-xs text-gray-400">/10</span>
        </div>
      </div>
    </div>
  </template>

  <!-- ===== POR QUE CONFIAR NO TECKHOME ===== -->
  <section id="por-que-confiar" class="py-20 px-4" style="background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);" aria-labelledby="confiar-title">
    <div class="max-w-6xl mx-auto">
      <div class="text-center mb-14">
        <span class="inline-flex items-center gap-2 bg-white/10 border border-white/20 text-white/80 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-4">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Confiança &amp; Transparência
        </span>
        <h2 id="confiar-title" class="text-3xl md:text-4xl font-black text-white mb-3">Por que confiar no TeckHome?</h2>
        <p class="text-white/60 max-w-xl mx-auto text-sm leading-relaxed">Somos um portal independente focado exclusivamente no benefício do consumidor.</p>
        <div class="w-12 h-1 bg-indigo-400 rounded-full mx-auto mt-4"></div>
      </div>

      <!-- Grid de diferenciais -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-14">
        <div class="benefit-card bg-white/8 border border-white/12 rounded-2xl p-6 text-center backdrop-blur-sm" style="background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.13);">
          <div class="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(99,102,241,0.25);">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="1.8" stroke-linecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
          <h3 class="font-black text-white text-sm mb-2">Reviews Detalhados</h3>
          <p class="text-white/55 text-xs leading-relaxed">Cada análise passa por um processo editorial rigoroso antes de ser publicada.</p>
        </div>
        <div class="benefit-card bg-white/8 border border-white/12 rounded-2xl p-6 text-center backdrop-blur-sm" style="background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.13);">
          <div class="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(16,185,129,0.2);">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" stroke-width="1.8" stroke-linecap="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
          </div>
          <h3 class="font-black text-white text-sm mb-2">Comparações Imparciais</h3>
          <p class="text-white/55 text-xs leading-relaxed">Comparamos produtos sem favorecimento de marcas ou lojas parceiras.</p>
        </div>
        <div class="benefit-card bg-white/8 border border-white/12 rounded-2xl p-6 text-center backdrop-blur-sm" style="background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.13);">
          <div class="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(245,158,11,0.2);">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <h3 class="font-black text-white text-sm mb-2">Atualizações Frequentes</h3>
          <p class="text-white/55 text-xs leading-relaxed">Nosso conteúdo é revisado periodicamente para refletir as condições atuais do mercado.</p>
        </div>
        <div class="benefit-card bg-white/8 border border-white/12 rounded-2xl p-6 text-center backdrop-blur-sm" style="background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.13);">
          <div class="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(139,92,246,0.2);">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.8" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
          <h3 class="font-black text-white text-sm mb-2">Foco no Consumidor</h3>
          <p class="text-white/55 text-xs leading-relaxed">Toda recomendação é pensada para quem vai comprar, não para quem vende.</p>
        </div>
      </div>

      <!-- Missão e valores -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div class="md:col-span-2 bg-white/8 border border-white/12 rounded-2xl p-8" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.1);">
          <span class="text-xs font-black text-indigo-400 uppercase tracking-widest">Nossa Missão</span>
          <h3 class="text-xl font-black text-white mt-2 mb-3">Ajudar consumidores a comprar melhor</h3>
          <p class="text-white/65 text-sm leading-relaxed mb-4">O TeckHome Store nasceu da necessidade de ter um portal genuinamente focado no consumidor brasileiro — sem jargões técnicos desnecessários, sem exageros de marketing e sem conflito de interesses. Queremos ser o recurso que você consulta antes de qualquer compra importante.</p>
          <p class="text-white/65 text-sm leading-relaxed">Acreditamos que informação de qualidade é um direito do consumidor. Por isso, investimos tempo em pesquisa, curadoria e análise para que você possa decidir com confiança.</p>
        </div>
        <div class="flex flex-col gap-4">
          <div class="bg-white/8 border border-white/12 rounded-2xl p-5 flex items-center gap-4" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.1);">
            <div class="w-10 h-10 rounded-xl bg-indigo-500/30 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div>
              <div class="text-white font-black text-sm">Transparência Total</div>
              <div class="text-white/50 text-xs mt-0.5">Divulgamos quando usamos links de afiliados</div>
            </div>
          </div>
          <div class="bg-white/8 border border-white/12 rounded-2xl p-5 flex items-center gap-4" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.1);">
            <div class="w-10 h-10 rounded-xl bg-emerald-500/30 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" stroke-width="2" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div>
              <div class="text-white font-black text-sm">Recomendações Éticas</div>
              <div class="text-white/50 text-xs mt-0.5">Só recomendamos o que realmente vale</div>
            </div>
          </div>
          <div class="bg-white/8 border border-white/12 rounded-2xl p-5 flex items-center gap-4" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.1);">
            <div class="w-10 h-10 rounded-xl bg-amber-500/30 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fcd34d" stroke-width="2" stroke-linecap="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            </div>
            <div>
              <div class="text-white font-black text-sm">Qualidade Editorial</div>
              <div class="text-white/50 text-xs mt-0.5">Padrão profissional em todo o conteúdo</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ===== EQUIPE TECKHOME (MELHORADA) ===== -->
  <section id="equipe-teckhome" class="py-20 px-4" style="background: linear-gradient(135deg, #f8faff 0%, #eef2ff 50%, #f0f9ff 100%);" aria-labelledby="equipe-title">
    <div class="max-w-5xl mx-auto">

      <div class="text-center mb-14">
        <span class="section-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          Equipe Editorial
        </span>
        <h2 id="equipe-title" class="section-title">Equipe TeckHome</h2>
        <p class="text-gray-500 mt-3 max-w-xl mx-auto text-sm">Uma equipe dedicada a pesquisa, análise e curadoria de produtos para facilitar sua decisão de compra.</p>
        <div class="section-divider mx-auto"></div>
      </div>

      <!-- Card equipe principal -->
      <div class="bg-white rounded-3xl shadow-xl border border-indigo-50 overflow-hidden mb-8" style="box-shadow: 0 20px 60px rgba(99,102,241,0.10);">
        <div class="h-1.5 w-full" style="background: linear-gradient(90deg, #6366f1, #818cf8, #38bdf8, #6366f1); background-size: 200% 100%; animation: gradientMove 4s linear infinite;"></div>
        <div class="p-8 md:p-10">
          <div class="flex flex-col md:flex-row items-center md:items-start gap-8">
            <div class="flex-shrink-0">
              <div class="relative">
                <div class="w-28 h-28 rounded-2xl flex items-center justify-center shadow-lg" style="background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #1e3a5f 100%);">
                  <div class="text-center">
                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                    <div class="text-white text-xs font-bold tracking-wide mt-1">TECH</div>
                  </div>
                </div>
                <div class="absolute -bottom-2 -right-2 w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center shadow-md border-2 border-white">
                  <i class="fas fa-check text-white text-xs"></i>
                </div>
              </div>
            </div>
            <div class="flex-1 text-center md:text-left">
              <h3 class="text-2xl font-black text-gray-900 mb-1">Equipe TeckHome</h3>
              <div class="flex items-center justify-center md:justify-start gap-2 mb-4">
                <span class="inline-flex items-center gap-1 text-xs text-indigo-600 font-semibold bg-indigo-50 px-3 py-1 rounded-full"><i class="fas fa-shield-alt text-xs"></i> Portal Verificado</span>
                <span class="inline-flex items-center gap-1 text-xs text-emerald-600 font-semibold bg-emerald-50 px-3 py-1 rounded-full"><span class="w-1.5 h-1.5 bg-emerald-500 rounded-full" style="animation: pulse 2s infinite;"></span> Ativo 2026</span>
              </div>
              <p class="text-gray-600 text-sm leading-relaxed mb-6">A Equipe TeckHome é formada por pesquisadores e entusiastas de tecnologia focados em ajudar consumidores brasileiros a fazer escolhas mais inteligentes. Nosso processo editorial combina pesquisa de mercado, análise de dados e curadoria especializada para entregar conteúdo de alta qualidade.</p>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div class="text-center p-3 bg-indigo-50 rounded-2xl border border-indigo-100">
                  <div class="text-xl font-black text-indigo-600">7+</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Categorias</div>
                </div>
                <div class="text-center p-3 bg-emerald-50 rounded-2xl border border-emerald-100">
                  <div class="text-xl font-black text-emerald-600">100%</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Imparcial</div>
                </div>
                <div class="text-center p-3 bg-blue-50 rounded-2xl border border-blue-100">
                  <div class="text-xl font-black text-blue-600">BR</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Mercado Local</div>
                </div>
                <div class="text-center p-3 bg-amber-50 rounded-2xl border border-amber-100">
                  <div class="text-xl font-black text-amber-600">2026</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Atualizado</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pilares editoriais -->
          <div class="mt-10 pt-8 border-t border-gray-100">
            <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-5">Nossos Pilares Editoriais</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="flex items-start gap-3 p-4 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-300 transition-all">
                <div class="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-search text-indigo-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Análise Técnica</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Reviews baseados em dados e avaliações reais de mercado</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-blue-50 rounded-2xl border border-blue-100 hover:border-blue-300 transition-all">
                <div class="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-balance-scale text-blue-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Comparativos</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Comparações honestas para facilitar sua decisão de compra</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-sky-50 rounded-2xl border border-sky-100 hover:border-sky-300 transition-all">
                <div class="w-9 h-9 bg-sky-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-home text-sky-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Foco no Lar</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Especialistas em tecnologia, eletrodomésticos e utilidades</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Como escolhemos os melhores -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
          <h3 class="font-black text-gray-900 text-base mb-3 flex items-center gap-2">
            <span class="w-7 h-7 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.2" stroke-linecap="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            </span>
            Como escolhemos os melhores
          </h3>
          <ul class="space-y-2.5 text-sm text-gray-600">
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Análise de avaliações reais de compradores verificados</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Comparação de especificações técnicas e desempenho</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Verificação de reputação da marca e suporte ao cliente</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Avaliação do custo-benefício real para o consumidor</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Revisão periódica para manter a atualidade das informações</li>
          </ul>
        </div>
        <div class="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-2xl p-6 text-white shadow-lg">
          <h3 class="font-black text-white text-base mb-3 flex items-center gap-2">
            <span class="w-7 h-7 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </span>
            Compromisso TeckHome
          </h3>
          <ul class="space-y-2.5 text-sm text-white/85">
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Transparência total sobre parcerias e afiliados</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Nunca recomendamos produto que não acreditamos</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Análise imparcial independente de comissão</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Conteúdo atualizado regularmente com dados reais</li>
            <li class="flex items-start gap-2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>Foco exclusivo no benefício do consumidor brasileiro</li>
          </ul>
        </div>
      </div>

    </div>
  </section>

  <!-- ===== FAQ ===== -->
  <section id="faq" class="bg-white py-20 px-4" aria-labelledby="faq-title">
    <div class="max-w-3xl mx-auto">
      <div class="text-center mb-12">
        <span class="section-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/></svg>
          Perguntas Frequentes
        </span>
        <h2 id="faq-title" class="section-title">Dúvidas sobre o TeckHome</h2>
        <p class="text-gray-500 mt-3 max-w-md mx-auto text-sm">Tudo o que você precisa saber sobre como funcionamos.</p>
        <div class="section-divider mx-auto"></div>
      </div>

      <div class="space-y-3" itemscope itemtype="https://schema.org/FAQPage">

        <!-- FAQ 1 -->
        <div class="faq-item border border-gray-100 rounded-2xl overflow-hidden" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
          <button class="faq-question w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors" onclick="toggleFaq(this)" aria-expanded="false">
            <span class="font-bold text-gray-800 text-sm pr-4" itemprop="name">Como os produtos são analisados no TeckHome?</span>
            <svg class="faq-icon flex-shrink-0 w-5 h-5 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="faq-answer px-5" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
            <div itemprop="text" class="pb-5 text-gray-600 text-sm leading-relaxed">
              Nossa equipe segue um processo editorial estruturado em 6 etapas: pesquisa de mercado, coleta de avaliações reais de compradores, comparação de especificações técnicas, análise de custo-benefício, verificação de qualidade e emissão de uma recomendação final. Apenas produtos que superam nossos critérios editoriais são publicados.
            </div>
          </div>
        </div>

        <!-- FAQ 2 -->
        <div class="faq-item border border-gray-100 rounded-2xl overflow-hidden" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
          <button class="faq-question w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors" onclick="toggleFaq(this)" aria-expanded="false">
            <span class="font-bold text-gray-800 text-sm pr-4" itemprop="name">O que são links de afiliados e como eles funcionam?</span>
            <svg class="faq-icon flex-shrink-0 w-5 h-5 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="faq-answer px-5" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
            <div itemprop="text" class="pb-5 text-gray-600 text-sm leading-relaxed">
              Links de afiliados são links rastreados que nos permitem receber uma pequena comissão quando você realiza uma compra através deles. Essa comissão é paga pela loja (Amazon, Mercado Livre, etc.) e <strong>não gera nenhum custo adicional para você</strong>. O preço é exatamente o mesmo que você pagaria acessando diretamente. Essa receita nos ajuda a manter o portal e produzir conteúdo gratuito de qualidade.
            </div>
          </div>
        </div>

        <!-- FAQ 3 -->
        <div class="faq-item border border-gray-100 rounded-2xl overflow-hidden" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
          <button class="faq-question w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors" onclick="toggleFaq(this)" aria-expanded="false">
            <span class="font-bold text-gray-800 text-sm pr-4" itemprop="name">Os preços e a disponibilidade dos produtos são atualizados?</span>
            <svg class="faq-icon flex-shrink-0 w-5 h-5 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="faq-answer px-5" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
            <div itemprop="text" class="pb-5 text-gray-600 text-sm leading-relaxed">
              Revisamos nosso conteúdo periodicamente para manter as informações atuais. No entanto, preços e disponibilidade podem variar a qualquer momento conforme promoções, estoque e políticas das lojas. Sempre recomendamos verificar o preço final diretamente na loja antes de finalizar sua compra.
            </div>
          </div>
        </div>

        <!-- FAQ 4 -->
        <div class="faq-item border border-gray-100 rounded-2xl overflow-hidden" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
          <button class="faq-question w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors" onclick="toggleFaq(this)" aria-expanded="false">
            <span class="font-bold text-gray-800 text-sm pr-4" itemprop="name">As recomendações são influenciadas por marcas ou lojas?</span>
            <svg class="faq-icon flex-shrink-0 w-5 h-5 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="faq-answer px-5" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
            <div itemprop="text" class="pb-5 text-gray-600 text-sm leading-relaxed">
              Não. Nossas recomendações são 100% editorialmente independentes. Embora possamos receber comissões de afiliados, nosso processo de análise e seleção de produtos não é influenciado por acordos comerciais com marcas ou lojas. Recomendamos produtos com base exclusivamente nos méritos que apresentam para o consumidor.
            </div>
          </div>
        </div>

        <!-- FAQ 5 -->
        <div class="faq-item border border-gray-100 rounded-2xl overflow-hidden" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
          <button class="faq-question w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors" onclick="toggleFaq(this)" aria-expanded="false">
            <span class="font-bold text-gray-800 text-sm pr-4" itemprop="name">Posso sugerir um produto para análise?</span>
            <svg class="faq-icon flex-shrink-0 w-5 h-5 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="faq-answer px-5" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
            <div itemprop="text" class="pb-5 text-gray-600 text-sm leading-relaxed">
              Sim! Adoramos receber sugestões da nossa comunidade. Entre em contato pelo e-mail <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 font-semibold hover:underline">contato@teckhomestore.com</a> com o nome do produto e o link de onde ele está disponível. Nossa equipe irá avaliar e, se atender aos critérios editoriais, incluiremos em nossa fila de análises.
            </div>
          </div>
        </div>

      </div>
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white pt-14 pb-6 px-4">
    <div class="max-w-7xl mx-auto">

      <!-- Grade principal do footer -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 pb-10 border-b border-gray-700">

        <!-- Coluna 1: Logo + descrição -->
        <div class="lg:col-span-1">
          <div class="flex items-center gap-3 mb-4">
            <img src="/static/logo.png" alt="TeckHome Store" class="w-12 h-12 rounded-xl object-cover shadow-lg">
            <div>
              <span class="text-xl font-black">Teck<span class="text-indigo-400">Home</span> Store</span>
              <p class="text-gray-400 text-xs mt-0.5">Descubra antes de comprar</p>
            </div>
          </div>
          <p class="text-gray-400 text-sm leading-relaxed mb-4">
            Portal de reviews, comparativos e recomendações de produtos para tecnologia, casa e utilidades do dia a dia.
          </p>
          <div class="flex flex-col gap-2 text-sm">
            <a href="https://teckhomestore.com" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
              <i class="fas fa-globe text-xs"></i> teckhomestore.com
            </a>
            <a href="mailto:contato@teckhomestore.com" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
              <i class="fas fa-envelope text-xs"></i> contato@teckhomestore.com
            </a>
          </div>
        </div>

        <!-- Coluna 2: Navegação -->
        <div>
          <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-5">Navegação</h4>
          <ul class="flex flex-col gap-3 text-sm text-gray-400">
            <li><a href="/" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-home text-xs text-indigo-400"></i> Início</a></li>
            <li><a href="#destaques" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-star text-xs text-indigo-400"></i> Destaques</a></li>
            <li><a href="#categorias" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-th-large text-xs text-indigo-400"></i> Categorias</a></li>
            <li><a href="#metodologia" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-search text-xs text-indigo-400"></i> Como Analisamos</a></li>
            <li><a href="#por-que-confiar" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-shield-alt text-xs text-indigo-400"></i> Por que Confiar</a></li>
            <li><a href="#equipe-teckhome" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-users text-xs text-indigo-400"></i> Equipe TeckHome</a></li>
            <li><a href="#faq" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-question-circle text-xs text-indigo-400"></i> FAQ</a></li>
            <li><a href="/admin" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-lock text-xs text-indigo-400"></i> Painel Admin</a></li>

          </ul>
        </div>

        <!-- Coluna 3: Categorias -->
        <div>
          <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-5">Categorias</h4>
          <ul class="flex flex-col gap-3 text-sm text-gray-400">
            <li><a href="/categoria/eletronicos" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> Eletrônicos</a></li>
            <li><a href="/categoria/eletrodomesticos" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><path d="M3 9l1-5h16l1 5"/><rect x="3" y="9" width="18" height="13" rx="1"/><path d="M8 9v13M16 9v13"/></svg> Eletrodomésticos</a></li>
            <li><a href="/categoria/ferramentas" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> Ferramentas</a></li>
            <li><a href="/categoria/refrigeracao" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07L19.07 4.93"/><circle cx="12" cy="12" r="2"/></svg> Refrigeração</a></li>
            <li><a href="/categoria/cama-mesa" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/></svg> Cama e Mesa</a></li>
            <li><a href="/categoria/ventilacao" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="2"/><path d="M12 9c0-3-1.5-6-3-6s-2 2.5-2 4c0 2.5 2 4 5 3"/></svg> Ventilação</a></li>
            <li><a href="/categoria/jardim" class="hover:text-white transition-colors flex items-center gap-2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="1.8" stroke-linecap="round"><path d="M12 22V12M12 12C12 7 7 4 3 6c0 5 4 8 9 6M12 12c0-5 5-8 9-6-1 5-5 8-9 6"/></svg> Jardim</a></li>
          </ul>
        </div>

        <!-- Coluna 4: Informações legais + Contato -->
        <div>
          <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-5">Informações</h4>
          <ul class="flex flex-col gap-3 text-sm text-gray-400">
            <li><a href="/termos-de-uso" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-file-alt text-xs text-indigo-400"></i> Termos de Uso</a></li>
            <li><a href="/politica-de-privacidade" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-shield-alt text-xs text-indigo-400"></i> Política de Privacidade</a></li>
            <li><a href="/politica-de-cookies" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-cookie-bite text-xs text-indigo-400"></i> Política de Cookies</a></li>
            <li><a href="/sobre" class="hover:text-white transition-colors flex items-center gap-2"><i class="fas fa-info-circle text-xs text-indigo-400"></i> Sobre Nós</a></li>
            <!-- Painel Admin: acesso via URL direta /admin -->
          </ul>
          <div class="mt-6 pt-5 border-t border-gray-700">
            <h4 class="text-white font-bold text-sm uppercase tracking-widest mb-3">Contato</h4>
            <a href="mailto:contato@teckhomestore.com" class="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-2">
              <i class="fas fa-envelope text-indigo-400 text-xs"></i> contato@teckhomestore.com
            </a>
            <a href="https://teckhomestore.com" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors">
              <i class="fas fa-globe text-indigo-400 text-xs"></i> teckhomestore.com
            </a>
          </div>
        </div>

      </div>

      <!-- Rodapé inferior: copyright + disclaimer -->
      <div class="pt-6 flex flex-col md:flex-row justify-between items-center gap-4 text-xs text-gray-500">
        <p>© 2026 TeckHome Store. Todos os direitos reservados.</p>
        <p class="text-center max-w-xl leading-relaxed">
          Este site contém links de afiliados. Podemos receber comissão por compras realizadas através dos links, sem custo adicional para você. Os preços e disponibilidade podem variar.
        </p>
        <p>Desenvolvido por <span class="text-indigo-400 font-semibold">Equipe TeckHome</span></p>
      </div>

    </div>
  </footer>

  <script>
    let allProductsCache = []

    // Mobile menu
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('mobileMenu').classList.toggle('hidden')
    })

    // FAQ accordion
    function toggleFaq(btn) {
      const answer = btn.nextElementSibling
      const icon = btn.querySelector('.faq-icon')
      const isOpen = answer.classList.contains('open')
      // Close all
      document.querySelectorAll('.faq-answer').forEach(a => a.classList.remove('open'))
      document.querySelectorAll('.faq-icon').forEach(i => i.classList.remove('open'))
      document.querySelectorAll('.faq-question').forEach(b => b.setAttribute('aria-expanded','false'))
      // Toggle current
      if (!isOpen) {
        answer.classList.add('open')
        icon.classList.add('open')
        btn.setAttribute('aria-expanded','true')
      }
    }

    // Newsletter
    function handleNewsletter(e) {
      e.preventDefault()
      const name = document.getElementById('nl-name').value.trim()
      const email = document.getElementById('nl-email').value.trim()
      if (!name || !email) return
      document.getElementById('newsletterForm').classList.add('hidden')
      document.getElementById('newsletterSuccess').classList.remove('hidden')
      // Future integration: POST to /api/newsletter
      console.log('Newsletter signup:', name, email)
    }

    // Rating system helper (reusable for article pages)
    function renderRatingSystem(container, ratings) {
      // ratings: [{label, score, max}] where score 0-max (default max=10)
      if (!container || !ratings || !ratings.length) return
      const colors = ['indigo','blue','purple','emerald','amber']
      let html = '<div class="th-rating-system bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">'
      html += '<div class="flex items-center gap-2 mb-5"><div class="w-8 h-8 bg-indigo-600 rounded-xl flex items-center justify-center"><svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></div><h4 class="font-black text-gray-900 text-sm">Nota TeckHome</h4></div>'
      html += '<div class="space-y-3">'
      let total = 0
      ratings.forEach((r, i) => {
        const max = r.max || 10
        const pct = Math.round((r.score / max) * 100)
        const color = colors[i % colors.length]
        total += r.score
        html += \`<div><div class="flex justify-between items-center mb-1"><span class="text-xs font-semibold text-gray-700">\${r.label}</span><span class="text-xs font-black text-\${color}-600">\${r.score}/\${max}</span></div><div class="w-full bg-gray-100 rounded-full h-2"><div class="rating-bar-fill bg-\${color}-500 h-2 rounded-full" style="width:\${pct}%"></div></div></div>\`
      })
      const avg = (total / ratings.length).toFixed(1)
      const stars = Math.round(avg / 2)
      html += '</div>'
      html += '<div class="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between">'
      html += '<span class="text-xs font-bold text-gray-400 uppercase tracking-wider">Nota Final</span>'
      html += '<div class="flex items-center gap-2">'
      html += Array.from({length:5},(_,i)=>\`<svg width="14" height="14" viewBox="0 0 24 24" fill="\${i<stars?'#f59e0b':'#d1d5db'}"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>\`).join('')
      html += \`<span class="text-2xl font-black text-indigo-600">\${avg}</span><span class="text-xs text-gray-400">/10</span>\`
      html += '</div></div></div>'
      container.innerHTML = html
    }
    window.renderRatingSystem = renderRatingSystem

    // Gera análise persuasiva automática baseada no produto
    function generateAnalysis(product, category) {
      const catName = category ? category.name : 'produtos'
      const store = product.store || 'grande loja'
      const title = product.title || 'produto'
      const analyses = [
        \`Se você está buscando qualidade comprovada em \${catName}, este produto se destaca entre os mais recomendados do mercado. Com avaliações positivas de consumidores reais e disponível na \${store}, ele entrega exatamente o que promete — sem surpresas desagradáveis na hora do uso.\`,
        \`Depois de analisar as principais opções disponíveis em \${catName}, este produto chama atenção pelo custo-benefício acima da média. É o tipo de escolha que você não se arrepende: robusto, funcional e bem avaliado por quem já comprou.\`,
        \`Quer fazer uma compra inteligente em \${catName}? Este é um dos produtos que nossa equipe recomenda com confiança. A combinação de qualidade, durabilidade e boa reputação o coloca entre os favoritos de quem entende do assunto.\`,
        \`Não perca tempo com produtos mediocres. Este item se destaca em \${catName} pela consistência nas avaliações e pela confiança que a \${store} oferece. É a escolha de quem quer acertar na compra sem precisar testar várias opções.\`,
        \`Para quem busca o melhor em \${catName} sem abrir mão da qualidade, este produto é uma das opções mais bem avaliadas disponíveis hoje. Nossa análise confirma o que os consumidores já dizem: vale cada centavo investido.\`
      ]
      const idx = (product.title.length + (category ? category.id.length : 0)) % analyses.length
      return analyses[idx]
    }

    // Gera prós e contras baseados no produto
    function generateProsContras(product, category) {
      const catName = category ? category.name : 'produtos'
      const prosList = [
        ['Excelente custo-benefício para a categoria', 'Durabilidade comprovada por compradores reais', 'Fácil de usar e instalar', 'Ótima relação qualidade × preço'],
        ['Alta qualidade de construção e acabamento', 'Desempenho consistente no uso diário', 'Design moderno e funcional', 'Boa reputação no mercado'],
        ['Destaque entre os mais vendidos em ' + catName, 'Avaliações positivas de usuários verificados', 'Suporte técnico acessível', 'Produto com garantia do fornecedor'],
        ['Entrega rápida e embalagem segura', 'Compatibilidade ampla com outros produtos', 'Material de qualidade superior', 'Tecnologia atualizada'],
        ['Eficiência energética acima da média', 'Economia a longo prazo garantida', 'Recomendado por especialistas', 'Melhor opção da faixa de preço']
      ]
      const contrasList = [
        ['Preço pode variar por demanda', 'Disponibilidade limitada em datas especiais'],
        ['Pode requerer adaptador em instalações antigas', 'Estoque pode esgotar rapidamente'],
        ['Manual apenas em português', 'Personalizações de cor limitadas'],
        ['Frete pode variar por região', 'Não inclui acessórios extras'],
        ['Prazo de entrega varia por localidade', 'Produto de alta demanda — compre logo']
      ]
      const idx = (product.title.length + (category ? category.id.length : 3)) % prosList.length
      return { pros: prosList[idx], contras: contrasList[idx] }
    }

    // Gera score de custo-benefício
    function getCostBenefit(product) {
      const score = 70 + ((product.title.length * 7 + (product.store || '').length * 3) % 28)
      const stars = Math.round(score / 20)
      return { score, stars }
    }

    function openProductModal(productId) {
      const product = allProductsCache.find(p => p.id === productId)
      if (!product) return
      const category = window._categoriesCache ? window._categoriesCache.find(c => c.id === product.categoryId) : null
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=600\`
      const { pros, contras } = generateProsContras(product, category)
      const { score, stars } = getCostBenefit(product)
      const analysis = generateAnalysis(product, category)
      const catColor = category ? category.color : '#6366f1'
      const catName = category ? category.name : 'Produto'

      const modal = document.getElementById('productModal')
      document.getElementById('modalContent').innerHTML = \`
        <div class="flex flex-col md:flex-row gap-0 md:gap-0 max-h-[90vh] overflow-y-auto">

          <!-- Imagem lado esquerdo -->
          <div class="md:w-2/5 flex-shrink-0 relative bg-gray-50">
            <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-64 md:h-full object-cover" style="min-height:260px;max-height:420px;" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=600'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent pointer-events-none"></div>
            \${product.featured ? '<div class="absolute top-3 left-3 bg-gradient-to-r from-yellow-400 to-orange-400 text-white text-xs font-bold px-3 py-1 rounded-xl shadow-lg flex items-center gap-1"><svg width="10" height="10" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Destaque</div>' : ''}
            <div class="absolute bottom-3 left-3 right-3">
              <span class="inline-block text-white text-xs font-bold px-3 py-1 rounded-xl" style="background:\${catColor}cc">\${catName}</span>
            </div>
          </div>

          <!-- Conteúdo lado direito -->
          <div class="flex-1 flex flex-col">

            <!-- Header -->
            <div class="p-5 pb-3 border-b border-gray-100">
              <h2 class="text-base font-black text-gray-900 leading-tight mb-3">\${product.title}</h2>

              <!-- Score custo-benefício -->
              <div class="flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-3 border border-indigo-100">
                <div class="text-center">
                  <div class="text-2xl font-black text-indigo-600">\${score}</div>
                  <div class="text-xs text-gray-400 font-medium">/ 100</div>
                </div>
                <div class="flex-1">
                  <div class="text-xs font-bold text-indigo-700 mb-1">Custo-Benefício TeckHome</div>
                  <div class="flex gap-0.5">\${Array.from({length:5},(_,i)=>'<svg width="14" height="14" viewBox="0 0 24 24" fill="'+(i<stars?'#f59e0b':'#d1d5db')+'"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>').join('')}</div>
                  <div class="w-full bg-gray-200 rounded-full h-1.5 mt-1.5">
                    <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-1.5 rounded-full" style="width:\${score}%"></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Análise -->
            <div class="p-5 pb-3">
              <div class="flex items-center gap-2 mb-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                <span class="text-xs font-bold text-indigo-700 uppercase tracking-wider">Análise Editorial</span>
              </div>
              <p class="text-gray-600 text-sm leading-relaxed">\${analysis}</p>
            </div>

            <!-- Prós e Contras -->
            <div class="px-5 pb-4 grid grid-cols-2 gap-3">
              <!-- Prós -->
              <div class="bg-green-50 rounded-xl p-3 border border-green-100">
                <div class="flex items-center gap-1.5 mb-2">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span class="text-xs font-black text-green-700 uppercase tracking-wide">Pontos Fortes</span>
                </div>
                <ul class="space-y-1.5">
                  \${pros.map(p => \`<li class="flex items-start gap-1.5 text-xs text-green-800"><svg width="10" height="10" viewBox="0 0 24 24" fill="#16a34a" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/><path fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" d="M20 6L9 17l-5-5"/></svg>\${p}</li>\`).join('')}
                </ul>
              </div>
              <!-- Contras -->
              <div class="bg-amber-50 rounded-xl p-3 border border-amber-100">
                <div class="flex items-center gap-1.5 mb-2">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                  <span class="text-xs font-black text-amber-700 uppercase tracking-wide">Atenção</span>
                </div>
                <ul class="space-y-1.5">
                  \${contras.map(c => \`<li class="flex items-start gap-1.5 text-xs text-amber-800"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M12 8v4M12 16h.01"/></svg>\${c}</li>\`).join('')}
                </ul>
              </div>
            </div>

            <!-- Botão Ver Preço -->
            <div class="p-5 pt-2 mt-auto border-t border-gray-100">
              <div class="flex items-center gap-2 mb-3">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span class="text-xs text-gray-400">Análise independente · Equipe TeckHome</span>
              </div>
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer sponsored"
                class="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-4 px-6 rounded-2xl transition-all shadow-lg hover:shadow-indigo-300 text-sm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                Ver Preço
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </a>
            </div>
          </div>
        </div>
      \`
      modal.classList.remove('hidden')
      document.body.style.overflow = 'hidden'
    }

    function closeProductModal() {
      document.getElementById('productModal').classList.add('hidden')
      document.body.style.overflow = ''
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProductModal() })

    function createProductCard(product, category) {
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1 shadow-lg">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=400\`
      const { score } = getCostBenefit(product)
      const catColor = category ? category.color : '#6366f1'
      const catSvgSmall = category ? getCatSvg(category.id, '#ffffff') : \`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>\`

      return \`
        <article class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col cursor-pointer" onclick="openProductModal('\${product.id}')" itemscope itemtype="https://schema.org/Product">
          <!-- Imagem -->
          <div class="relative overflow-hidden">
            <div class="h-52 overflow-hidden bg-gray-50">
              <img src="\${imgSrc}" alt="\${product.title} — Review TeckHome Store" loading="lazy" decoding="async" class="w-full h-full object-cover hover:scale-110 transition-transform duration-500" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=400'" itemprop="image">
            </div>
            \${featuredBadge}
            <div class="absolute top-3 right-3 w-9 h-9 rounded-xl flex items-center justify-center shadow-md" style="background:\${catColor};">
              \${catSvgSmall.replace(/width="28" height="28"/g,'width="18" height="18"')}
            </div>
            <!-- Overlay lupa -->
            <div class="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
              <div class="bg-white/90 rounded-2xl px-4 py-2 flex items-center gap-2 shadow-lg">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <span class="text-xs font-bold text-indigo-700">Ver Análise</span>
              </div>
            </div>
          </div>

          <!-- Conteúdo -->
          <div class="p-4 flex flex-col flex-1 gap-3">
            <h3 class="font-black text-gray-900 text-sm leading-snug line-clamp-2" itemprop="name">\${product.title}</h3>

            <!-- Score custo-benefício compacto -->
            <div class="flex items-center gap-2">
              <div class="flex-1 bg-gray-100 rounded-full h-1.5">
                <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-1.5 rounded-full" style="width:\${score}%"></div>
              </div>
              <span class="text-xs font-black text-indigo-600">\${score}/100</span>
              <span class="text-xs text-gray-400">custo-benef.</span>
            </div>

            <!-- Trust signals -->
            <div class="flex items-center gap-2 flex-wrap">
              <span class="trust-badge text-xs font-semibold text-green-700 px-2.5 py-1 rounded-lg flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Verificado
              </span>
              <span class="bg-amber-50 border border-amber-200 text-xs font-semibold text-amber-700 px-2.5 py-1 rounded-lg flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="#d97706"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                Recomendado
              </span>
            </div>

            <!-- CTA -->
            <div class="mt-auto pt-1">
              <button onclick="event.stopPropagation();openProductModal('\${product.id}')" class="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold px-4 py-3 rounded-xl transition-all shadow-md">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                Ver Análise Completa
              </button>
            </div>
          </div>

          <!-- Editorial footer -->
          <div class="editorial-footer px-4 py-3 flex items-center gap-2 rounded-b-2xl">
            <div class="w-5 h-5 rounded-md flex-shrink-0 flex items-center justify-center" style="background: linear-gradient(135deg, #1e1b4b, #3730a3);">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            </div>
            <div class="min-w-0 flex items-center gap-1">
              <span class="text-xs font-bold text-indigo-700">Equipe TeckHome</span>
              <span class="text-gray-300 text-xs">·</span>
              <span class="text-xs text-gray-400">Análise independente</span>
            </div>
          </div>
        </article>
      \`
    }

    // SVGs por categoria — sem dependência de fontes de emoji
    const CATEGORY_SVGS = {
      'eletronicos': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M6 8h.01M9 8h6"/></svg>\`,
      'eletrodomesticos': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><rect x="3" y="9" width="18" height="13" rx="1"/><path d="M8 9v13M16 9v13"/><circle cx="16" cy="5" r="1" fill="currentColor"/></svg>\`,
      'ferramentas': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>\`,
      'refrigeracao': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07L19.07 4.93"/><circle cx="12" cy="12" r="3"/></svg>\`,
      'cama-mesa': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20M6 8v9"/><rect x="6" y="5" width="6" height="3" rx="1"/></svg>\`,
      'ventilacao': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M12 9c0-3-1.5-6-3-6s-2 2.5-2 4c0 2.5 2 4 5 3"/><path d="M14.6 13.5c2.6 1.5 5.4 1.8 6.4.3s-.5-4-2.5-5c-2.2-1.2-4.5-.4-5.5 2.5"/><path d="M9.4 13.5C6.8 15 4 15.3 3 13.8s.5-4 2.5-5c2.2-1.2 4.5-.4 5.5 2.5"/></svg>\`,
      'jardim': \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22V12M12 12C12 7 7 4 3 6c0 5 4 8 9 6M12 12c0-5 5-8 9-6-1 5-5 8-9 6"/></svg>\`
    }

    function getCatSvg(catId, color) {
      const svg = CATEGORY_SVGS[catId] || \`<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>\`
      return svg.replace(/stroke="currentColor"/g, \`stroke="\${color}"\`).replace(/fill="currentColor"/g, \`fill="\${color}"\`)
    }

    async function loadCategories() {
      const res = await fetch('/api/categories')
      const categories = await res.json()
      
      const grid = document.getElementById('categoriesGrid')
      grid.innerHTML = categories.map(cat => \`
        <a href="/categoria/\${cat.id}" class="category-card card-hover bg-white rounded-2xl p-5 border border-gray-100 flex flex-col items-start gap-4 cursor-pointer group" style="text-decoration:none; box-shadow:0 2px 12px rgba(0,0,0,0.06);">
          <div class="cat-icon-wrap w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0" style="background:linear-gradient(135deg,\${cat.color}15,\${cat.color}30); border:1.5px solid \${cat.color}30;">
            \${getCatSvg(cat.id, cat.color)}
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="font-black text-gray-800 group-hover:text-indigo-600 transition-colors text-sm tracking-tight mb-1">\${cat.name}</h3>
            <p class="text-gray-400 text-xs leading-relaxed line-clamp-2">\${cat.description}</p>
          </div>
          <div class="w-full flex items-center justify-between pt-2 border-t" style="border-color:\${cat.color}20;">
            <span style="color:\${cat.color}; font-size:0.72rem; font-weight:800; letter-spacing:0.04em; text-transform:uppercase;">Ver produtos</span>
            <div class="w-6 h-6 rounded-lg flex items-center justify-center" style="background:\${cat.color}15;">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8M7 3l3 3-3 3" stroke="\${cat.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
          </div>
        </a>
      \`).join('')

      return categories
    }

    async function loadFeatured(categories) {
      const res = await fetch('/api/products')
      allProductsCache = await res.json()

      // Tenta pegar os marcados como destaque; se não houver, usa os 4 mais recentes
      let featured = allProductsCache.filter(p => p.featured).slice(0, 8)
      const usingFallback = featured.length === 0 && allProductsCache.length > 0
      if (usingFallback) featured = allProductsCache.slice(0, 4)

      const grid = document.getElementById('featuredGrid')
      const noFeatured = document.getElementById('noFeatured')
      const sectionTitle = document.getElementById('featuredSectionTitle')

      if (featured.length === 0) {
        grid.innerHTML = ''
        noFeatured.classList.remove('hidden')
        return
      }

      noFeatured.classList.add('hidden')
      // Atualiza título se estiver usando fallback
      if (usingFallback && sectionTitle) {
        sectionTitle.textContent = 'Produtos Adicionados Recentemente'
      }

      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)
      grid.innerHTML = featured.map(p => createProductCard(p, catMap[p.categoryId])).join('')
    }

    function handleSearch(query) {
      const searchResults = document.getElementById('searchResults')
      const heroSection = document.getElementById('categorias')
      
      if (!query.trim()) {
        searchResults.classList.add('hidden')
        return
      }
      
      const q = query.toLowerCase()
      const filtered = allProductsCache.filter(p => 
        p.title.toLowerCase().includes(q) || 
        p.description.toLowerCase().includes(q) ||
        (p.store && p.store.toLowerCase().includes(q))
      )
      
      searchResults.classList.remove('hidden')
      
      const grid = document.getElementById('searchGrid')
      const noResults = document.getElementById('noResults')
      
      if (filtered.length === 0) {
        grid.innerHTML = ''
        noResults.classList.remove('hidden')
      } else {
        noResults.classList.add('hidden')
        grid.innerHTML = filtered.slice(0, 12).map(p => createProductCard(p, null)).join('')
      }
    }

    // Artigos do blog (estáticos + dinâmicos via admin)
    const staticArticles = [
      {
        id: 'guia-eletronicos',
        slug: 'guia-eletronicos',
        url: '/artigo/guia-eletronicos',
        title: 'Como escolher o melhor smartphone em 2026: tudo que você precisa saber antes de comprar',
        excerpt: 'Você está prestes a gastar centenas de reais em um celular — e pode cometer o mesmo erro que milhares de brasileiros cometem todo ano: comprar pelo nome da marca, e não pelo que o produto realmente entrega. Neste guia, revelamos os 5 critérios que profissionais de tecnologia usam para avaliar smartphones, e que vão mudar completamente a forma como você escolhe o próximo aparelho.',
        category: 'Eletrônicos',
        categoryIcon: '📱',
        image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=600&q=80',
        readTime: '6 min',
        keywords: 'melhor smartphone 2026, como escolher celular, review celular custo-benefício, smartphone barato bom'
      },
      {
        id: 'guia-eletrodomesticos',
        slug: 'guia-eletrodomesticos',
        url: '/artigo/guia-eletrodomesticos',
        title: 'Air fryer ou forno elétrico? A verdade que as marcas não te contam — e qual comprar em 2026',
        excerpt: 'A air fryer se tornou febre no Brasil — mas será que ela é realmente superior ao forno elétrico, ou é apenas marketing bem feito? Nossa equipe testou os dois aparelhos e a resposta vai surpreender você. Descubra qual realmente vale a pena para a sua cozinha antes de gastar seu dinheiro.',
        category: 'Eletrodomésticos',
        categoryIcon: '🏠',
        image: 'https://images.unsplash.com/photo-1585515320310-259814833e62?w=600&q=80',
        readTime: '7 min',
        keywords: 'air fryer vs forno elétrico, melhor air fryer 2026, qual comprar, air fryer consume energia'
      },
      {
        id: 'guia-refrigeracao',
        slug: 'guia-refrigeracao',
        url: '/artigo/guia-refrigeracao',
        title: 'Ar-condicionado em 2026: split, portátil ou janela? O guia definitivo para escolher sem erro',
        excerpt: 'Comprar o ar-condicionado errado pode te custar mais de R$ 500 extras por ano só na conta de luz. Neste guia, calculamos o BTU ideal para cada ambiente e comparamos split, portátil e janela com dados reais de consumo.',
        category: 'Refrigeração',
        categoryIcon: '❄️',
        image: 'https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=600&q=80',
        readTime: '8 min',
        keywords: 'ar condicionado split vs portátil, melhor ar condicionado 2026, BTU ideal, ar condicionado econômico'
      },
      {
        id: 'guia-ferramentas',
        slug: 'guia-ferramentas',
        url: '/artigo/guia-ferramentas',
        title: 'As 7 ferramentas elétricas que todo proprietário de imóvel precisa ter em casa',
        excerpt: 'Com um kit de ferramentas básico que custa entre R$ 400 e R$ 800, você recupera o investimento em 3-4 chamados de técnico evitados. Veja quais são as 7 ferramentas essenciais que nossa equipe selecionou com análise real de custo-benefício, durabilidade e marcas confiáveis disponíveis no Brasil.',
        category: 'Ferramentas',
        categoryIcon: '🔧',
        image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=600&q=80',
        readTime: '6 min',
        keywords: 'ferramentas elétricas essenciais, melhor parafusadeira 2026, kit ferramentas casa, ferramentas custo-benefício'
      },
      {
        id: 'guia-cama-mesa',
        slug: 'guia-cama-mesa',
        url: '/artigo/guia-cama-mesa',
        title: 'Cama e Mesa em 2026: como montar um quarto confortável e elegante sem gastar uma fortuna',
        excerpt: 'A qualidade do seu sono depende diretamente da qualidade da sua cama — e não é necessário gastar uma fortuna para dormir muito melhor. Descubra os critérios que realmente fazem diferença na escolha de colchão, travesseiro e roupa de cama.',
        category: 'Cama e Mesa',
        categoryIcon: '🛏️',
        image: 'https://images.unsplash.com/photo-1540518614846-7eded433c457?w=600&q=80',
        readTime: '8 min',
        keywords: 'jogo de cama qualidade, travesseiro ideal, colchão custo-benefício, roupa de cama 2026, melhor colchão casal'
      },
      {
        id: 'guia-jardim',
        slug: 'guia-jardim',
        url: '/artigo/guia-jardim',
        title: 'Jardim em casa: como começar do zero e criar um espaço verde bonito mesmo sem experiência',
        excerpt: 'Criar um jardim bonito e saudável não exige conhecimento avançado em botânica — exige as plantas certas para o seu espaço, as ferramentas adequadas e alguns hábitos simples. Este guia completo é para quem quer começar hoje.',
        category: 'Jardim',
        categoryIcon: '🌿',
        image: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=600&q=80',
        readTime: '9 min',
        keywords: 'jardim em casa iniciantes, como cuidar de plantas, horta em apartamento 2026, ferramentas para jardim'
      },
      {
        id: 'guia-ventilacao',
        slug: 'guia-ventilacao',
        url: '/artigo/guia-ventilacao',
        title: 'Ventilador ou ar-condicionado? O guia completo sobre ventilação doméstica em 2026',
        excerpt: 'Em um Brasil onde o calor bate 35°C por meses seguidos, escolher o sistema de ventilação correto pode significar economia de até R$ 150 por mês na conta de luz. Entenda as diferenças entre ventilador de teto, climatizador e ar-condicionado.',
        category: 'Ventilação',
        categoryIcon: '💨',
        image: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&q=80',
        readTime: '7 min',
        keywords: 'ventilador de teto custo-benefício, ventilador vs ar condicionado, climatizador evaporativo 2026'
      }
    ]

    async function loadBlog() {
      // Busca artigos do admin
      let adminArticles = []
      try {
        const res = await fetch('/api/articles')
        if (res.ok) adminArticles = await res.json()
      } catch(e) {}

      const allArticles = [...adminArticles, ...staticArticles].slice(0, 8)
      const grid = document.getElementById('blogGrid')
      const noBlog = document.getElementById('noBlog')

      if (allArticles.length === 0) {
        grid.innerHTML = ''
        noBlog.classList.remove('hidden')
        return
      }

      grid.innerHTML = allArticles.map((art, i) => {
        const artUrl = art.url || (art.slug ? \`/artigo/\${art.slug}\` : '#blog')
        const isFirst = i === 0
        return \`
        <a href="\${artUrl}" class="blog-card bg-white rounded-2xl overflow-hidden border border-gray-100 flex flex-col cursor-pointer" style="text-decoration:none; box-shadow:0 2px 16px rgba(99,102,241,0.07);" itemscope itemtype="https://schema.org/Article">
          <div class="blog-card-img relative bg-gray-100" style="height:\${isFirst ? '220px' : '200px'}">
            <img src="\${art.image || 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80'}"
              alt="\${art.title}"
              class="w-full h-full object-cover"
              loading="lazy"
              onerror="this.src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80'"
              itemprop="image">
            <!-- Gradient overlay -->
            <div class="absolute inset-0" style="background:linear-gradient(to top,rgba(0,0,0,0.45) 0%,transparent 55%);"></div>
            <div class="absolute top-3 left-3">
              <span class="bg-indigo-600/90 backdrop-blur-sm text-white text-xs font-bold px-3 py-1 rounded-full shadow">\${art.category || 'Review'}</span>
            </div>
            <div class="absolute top-3 right-3">
              <span class="bg-black/50 backdrop-blur-sm text-white/90 text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                \${art.readTime || '4 min'}
              </span>
            </div>
          </div>
          <div class="p-5 flex flex-col flex-1">
            <h3 class="font-black text-gray-900 text-base leading-snug mb-2 line-clamp-2" style="letter-spacing:-0.01em;" itemprop="headline">\${art.title}</h3>
            <p class="text-gray-500 text-sm leading-relaxed line-clamp-3 flex-1 mb-4" itemprop="description">\${art.excerpt}</p>
            <div class="pt-3 border-t border-gray-100 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-black" style="background:linear-gradient(135deg,#4f46e5,#3730a3);">TH</div>
                <div>
                  <div class="text-xs font-bold text-gray-700">Equipe TeckHome</div>
                  <div class="text-xs text-gray-400">Editorial</div>
                </div>
              </div>
              <span class="text-xs font-black text-indigo-600 flex items-center gap-1.5 bg-indigo-50 px-3 py-1.5 rounded-full hover:bg-indigo-100 transition-colors">
                Ler <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </span>
            </div>
          </div>
        </a>
      \`}).join('')
    }

    // === COMPARATIVOS HOME ===
    async function loadHomeComparativos() {
      try {
        const res = await fetch('/api/comparativos')
        const all = await res.json()
        const active = all.filter(c => c.status === 'active' && c.products && c.products.length >= 2)
        const grid = document.getElementById('homeComparativosGrid')
        const empty = document.getElementById('homeComparativosEmpty')
        const section = document.getElementById('comparativos-home')
        if (!active.length) {
          if (grid) grid.innerHTML = ''
          if (empty) empty.classList.remove('hidden')
          if (section) section.classList.add('hidden')
          return
        }
        if (empty) empty.classList.add('hidden')
        if (section) section.classList.remove('hidden')
        if (grid) grid.innerHTML = active.slice(0, 3).map(cmp => renderHomeComparativoCard(cmp)).join('')
      } catch(e) {
        const section = document.getElementById('comparativos-home')
        if (section) section.classList.add('hidden')
      }
    }

    function gerarAnaliseIA(cmp) {
      var prods = (cmp.products || []).slice(0, 4)
      if (prods.length < 2) return ''
      var bestProd = prods.find(function(p) { return p.badge === 'best' }) || prods[0]
      var cbProd = prods.find(function(p) { return p.badge === 'costbenefit' })
      var analisePreco = ''
      var prodsComPreco = prods.filter(function(p) { return p.price })
      if (prodsComPreco.length >= 2) {
        var precos = prodsComPreco.map(function(p) {
          var n = parseFloat((p.price || '').replace(/[^0-9,]/g,'').replace(',','.'))
          return { name: p.name, val: n, price: p.price }
        }).filter(function(x) { return !isNaN(x.val) }).sort(function(a,b) { return a.val - b.val })
        if (precos.length >= 2) {
          var barato = precos[0]
          var caro = precos[precos.length-1]
          var pct = (((caro.val - barato.val) / caro.val) * 100).toFixed(0)
          analisePreco = 'A diferença de preço entre o <strong>' + barato.name + '</strong> (' + barato.price + ') e o <strong>' + caro.name + '</strong> (' + caro.price + ') é de aproximadamente <strong>' + pct + '%</strong>. '
        }
      }
      var analiseRating = ''
      var prodsComRating = prods.filter(function(p) { return parseFloat(p.rating) > 0 })
      if (prodsComRating.length >= 2) {
        var melhorR = prodsComRating.slice().sort(function(a,b) { return parseFloat(b.rating)-parseFloat(a.rating) })[0]
        analiseRating = 'Em termos de avaliação dos usuários, o <strong>' + melhorR.name + '</strong> se destaca com <strong>' + parseFloat(melhorR.rating).toFixed(1) + ' estrelas</strong>. '
      }
      var analisePros = ''
      var custoProd = cbProd || bestProd
      if (custoProd && (custoProd.pros || []).length > 0) {
        var dif = (custoProd.pros || []).slice(0,2).join(' e ')
        if (dif) analisePros = 'O <strong>' + custoProd.name + '</strong> se sobressai principalmente por ' + dif.toLowerCase() + '. '
      }
      var recomendacao = ''
      if (bestProd && cbProd && bestProd.name !== cbProd.name) {
        recomendacao = '<strong>🏆 Melhor desempenho:</strong> <span style="color:#7c3aed">' + bestProd.name + '</span> — ideal para quem busca o melhor resultado sem compromisso. <strong>💚 Melhor custo-benefício:</strong> <span style="color:#059669">' + cbProd.name + '</span> — excelente opção para quem quer ótima qualidade gastando menos.'
      } else if (bestProd) {
        recomendacao = 'Para a maioria dos compradores, o <strong>' + bestProd.name + '</strong> oferece a melhor relação entre qualidade e investimento nesta categoria.'
      }
      if (!analisePreco && !analiseRating && !analisePros && !recomendacao) return ''
      return \`
        <div style="background:linear-gradient(135deg,#faf5ff,#f3f0ff);border-radius:16px;padding:20px 24px;border:1px solid #e9d5ff;margin-top:20px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <div style="width:28px;height:28px;background:linear-gradient(135deg,#7c3aed,#6366f1);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 7v4m0 4h.01"/></svg>
            </div>
            <span style="font-size:11px;font-weight:800;color:#7c3aed;text-transform:uppercase;letter-spacing:0.8px;">🤖 Análise TeckHome IA</span>
          </div>
          <p style="font-size:13px;color:#374151;line-height:1.75;margin:0 0 \${recomendacao ? '10px' : '0'};">\${analisePreco}\${analiseRating}\${analisePros}</p>
          \${recomendacao ? '<div style="font-size:13px;color:#374151;line-height:1.7;padding-top:10px;border-top:1px solid #ddd6fe;">' + recomendacao + '</div>' : ''}
        </div>
      \`
    }

    function renderHomeComparativoCard(cmp) {
      const prods = (cmp.products || []).slice(0, 4)
      const starsHtml = (r) => {
        const v = parseFloat(r) || 0
        return Array.from({length:5}, (_,i) =>
          \`<svg width="12" height="12" viewBox="0 0 24 24" fill="\${i<Math.floor(v)?'#f59e0b':i<v?'#fcd34d':'#e5e7eb'}"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>\`
        ).join('')
      }
      const badgeHtml = (p) => {
        if (p.badge === 'best') return '<span style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:white;font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;white-space:nowrap;letter-spacing:0.3px;">🏆 MELHOR ESCOLHA</span>'
        if (p.badge === 'costbenefit') return '<span style="background:linear-gradient(135deg,#059669,#10b981);color:white;font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;white-space:nowrap;letter-spacing:0.3px;">💚 CUSTO-BENEFÍCIO</span>'
        return ''
      }
      const borderColor = (p) => p.badge === 'best' ? '#c4b5fd' : p.badge === 'costbenefit' ? '#6ee7b7' : '#e5e7eb'
      const bgCard = (p) => p.badge === 'best' ? 'linear-gradient(135deg,#faf5ff,#ffffff)' : p.badge === 'costbenefit' ? 'linear-gradient(135deg,#f0fdf4,#ffffff)' : 'white'
      const analiseIA = gerarAnaliseIA(cmp)

      return \`
        <div style="background:white;border-radius:24px;border:1px solid #e5e7eb;box-shadow:0 8px 40px rgba(124,58,237,0.1);position:relative;overflow:hidden;">
          <!-- Barra superior colorida -->
          <div style="height:5px;background:linear-gradient(90deg,#7c3aed,#6366f1,#818cf8,#a78bfa);"></div>

          <div style="padding:28px 28px 24px;">
            <!-- Cabeçalho do comparativo -->
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap;">
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                  <span style="display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,#f3f0ff,#ede9fe);color:#7c3aed;font-size:10px;font-weight:800;padding:4px 12px;border-radius:20px;border:1px solid #c4b5fd;text-transform:uppercase;letter-spacing:0.5px;">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15H6M15 18l3-3-3-3M9 18l-3-3 3-3"/></svg>
                    Comparativo
                  </span>
                  \${cmp.category ? \`<span style="background:#f8fafc;color:#64748b;font-size:10px;font-weight:600;padding:4px 10px;border-radius:20px;border:1px solid #e2e8f0;">\${cmp.category}</span>\` : ''}
                  <span style="background:#f0fdf4;color:#059669;font-size:10px;font-weight:600;padding:4px 10px;border-radius:20px;border:1px solid #bbf7d0;">\${prods.length} produtos</span>
                </div>
                <h3 style="font-size:20px;font-weight:900;color:#111827;margin:0 0 6px;line-height:1.3;">\${cmp.title}</h3>
                \${cmp.summary ? \`<p style="font-size:13px;color:#6b7280;margin:0;line-height:1.65;max-width:680px;">\${cmp.summary}</p>\` : ''}
              </div>
            </div>

            <!-- Cards dos produtos lado a lado -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:16px;margin-bottom:4px;">
              \${prods.map(p => \`
                <div style="border:2px solid \${borderColor(p)};border-radius:18px;padding:20px 16px;position:relative;background:\${bgCard(p)};transition:transform 0.2s,box-shadow 0.2s;display:flex;flex-direction:column;" onmouseover="this.style.transform='translateY(-4px)';this.style.boxShadow='0 12px 32px rgba(0,0,0,0.12)'" onmouseout="this.style.transform='none';this.style.boxShadow='none'">
                  \${p.badge ? \`<div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);white-space:nowrap;z-index:2;">\${badgeHtml(p)}</div>\` : ''}
                  <!-- Imagem e nome -->
                  <div style="text-align:center;margin-bottom:14px;\${p.badge?'padding-top:8px':''}">
                    \${p.image
                      ? \`<img src="\${p.image}" alt="\${p.name||'Produto'}" style="width:80px;height:80px;object-fit:cover;border-radius:14px;border:2px solid \${borderColor(p)};margin:0 auto 10px;display:block;box-shadow:0 4px 12px rgba(0,0,0,0.08);" loading="lazy" onerror="this.style.display='none'">\`
                      : \`<div style="width:80px;height:80px;background:linear-gradient(135deg,#f3f0ff,#ede9fe);border-radius:14px;margin:0 auto 10px;display:flex;align-items:center;justify-content:center;font-size:28px;border:2px solid #e9d5ff;">📦</div>\`}
                    <p style="font-size:13px;font-weight:800;color:#1f2937;margin:0 0 6px;line-height:1.3;">\${p.name || 'Produto'}</p>
                    <div style="display:flex;justify-content:center;gap:1px;margin-bottom:5px;">\${starsHtml(p.rating)}</div>
                    \${p.rating ? \`<span style="font-size:11px;color:#6b7280;">\${parseFloat(p.rating).toFixed(1)}/5.0</span>\` : ''}
                    \${p.price ? \`<p style="font-size:17px;font-weight:900;color:#059669;margin:8px 0 0;">\${p.price}</p>\` : ''}
                  </div>
                  <!-- Prós -->
                  \${(p.pros||[]).length ? \`
                    <div style="margin-bottom:8px;">
                      \${(p.pros||[]).slice(0,3).map(pro => \`
                        <div style="font-size:11.5px;color:#065f46;display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;background:#f0fdf4;padding:3px 7px;border-radius:6px;">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="3" style="flex-shrink:0;margin-top:1px;"><path d="M20 6L9 17l-5-5"/></svg>
                          <span>\${pro}</span>
                        </div>
                      \`).join('')}
                    </div>
                  \` : ''}
                  <!-- Contras -->
                  \${(p.cons||[]).length ? \`
                    <div style="margin-bottom:12px;">
                      \${(p.cons||[]).slice(0,2).map(con => \`
                        <div style="font-size:11.5px;color:#991b1b;display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;background:#fff5f5;padding:3px 7px;border-radius:6px;">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="3" style="flex-shrink:0;margin-top:1px;"><path d="M18 6L6 18M6 6l12 12"/></svg>
                          <span>\${con}</span>
                        </div>
                      \`).join('')}
                    </div>
                  \` : ''}
                  <!-- Botão -->
                  <div style="margin-top:auto;">
                    \${p.affiliateUrl
                      ? \`<a href="\${p.affiliateUrl}" target="_blank" rel="noopener sponsored" style="display:block;text-align:center;background:\${p.badge==='best'?'linear-gradient(135deg,#7c3aed,#6366f1)':p.badge==='costbenefit'?'linear-gradient(135deg,#059669,#10b981)':'linear-gradient(135deg,#6366f1,#818cf8)'};color:white;font-size:12px;font-weight:700;padding:10px 14px;border-radius:12px;text-decoration:none;transition:opacity 0.2s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">Ver Preço →</a>\`
                      : \`<div style="text-align:center;font-size:11px;color:#9ca3af;padding:8px;">Busque nas lojas</div>\`}
                  </div>
                </div>
              \`).join('')}
            </div>

            <!-- Análise IA gerada automaticamente -->
            \${analiseIA}

            <!-- Conclusão editorial (se preenchida no admin) -->
            \${cmp.conclusion ? \`
              <div style="background:linear-gradient(135deg,#fffbeb,#fef3c7);border-radius:14px;padding:16px 20px;border-left:4px solid #f59e0b;margin-top:16px;">
                <p style="font-size:11px;font-weight:800;color:#92400e;margin:0 0 5px;text-transform:uppercase;letter-spacing:0.5px;">📝 Conclusão Editorial</p>
                <p style="font-size:13px;color:#374151;margin:0;line-height:1.75;">\${cmp.conclusion}</p>
              </div>
            \` : ''}
          </div>
        </div>
      \`
    }

    async function init() {
      const categories = await loadCategories()
      window._categoriesCache = categories
      await loadFeatured(categories)
      await loadHomeComparativos()
      await loadBlog()
    }

    init()
  </script>

  <!-- MODAL DE PRODUTO -->
  <div id="productModal" class="hidden fixed inset-0 z-[999] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);" onclick="if(event.target===this)closeProductModal()">
    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden relative" style="max-height:92vh;">
      <!-- Botão fechar -->
      <button onclick="closeProductModal()" class="absolute top-4 right-4 z-10 w-9 h-9 bg-white/90 hover:bg-red-50 border border-gray-200 hover:border-red-200 rounded-xl flex items-center justify-center transition-all shadow-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <div id="modalContent"></div>
    </div>
  </div>

</body>
</html>`
}

function categoryPage(categoryId: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>TeckHome Store - Categoria</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; box-sizing: border-box; }
    .card-hover { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card-hover:hover { transform: translateY(-8px); box-shadow: 0 25px 50px rgba(0,0,0,0.15); }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .trust-badge { background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 1px solid #bbf7d0; }
    .editorial-footer { background: linear-gradient(135deg, #f8faff, #eef2ff); border-top: 1px solid #e0e7ff; }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 4px; }
    /* Fix FontAwesome icons */
    i.fas, i.fa, i.far { font-family: 'Font Awesome 6 Free' !important; font-weight: 900 !important; font-style: normal !important; }
    i.fab { font-family: 'Font Awesome 6 Brands' !important; font-weight: 400 !important; font-style: normal !important; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Descubra antes de comprar</span>
          </div>
        </a>
        <div class="flex items-center gap-4">
          <a href="/" class="text-sm font-medium text-gray-600 hover:text-indigo-600 transition-colors flex items-center gap-1">
            <i class="fas fa-home text-xs"></i> Início
          </a>

        </div>
      </div>
    </div>
  </nav>

  <!-- HEADER DA CATEGORIA -->
  <div id="categoryHeader" class="py-12 px-4">
    <div class="max-w-7xl mx-auto">
      <div class="shimmer h-8 w-48 rounded-xl mb-2"></div>
      <div class="shimmer h-5 w-80 rounded-xl"></div>
    </div>
  </div>

  <!-- FILTROS -->
  <div class="max-w-7xl mx-auto px-4 mb-6">
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-wrap items-center gap-3">
      <span class="text-sm font-semibold text-gray-700 mr-2">Filtrar:</span>
      <button onclick="filterProducts('all')" id="filter-all" class="filter-btn active-filter text-xs font-medium px-3 py-1.5 rounded-xl border border-indigo-600 bg-indigo-600 text-white transition-all">
        Todos
      </button>
      <button onclick="filterProducts('featured')" id="filter-featured" class="filter-btn text-xs font-medium px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition-all">
        ⭐ Destaques
      </button>
      <div class="ml-auto">
        <input id="catSearch" type="text" placeholder="Buscar nesta categoria..." 
          class="text-sm px-4 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 w-52"
          oninput="filterBySearch(this.value)">
      </div>
    </div>
  </div>

  <!-- GRID DE PRODUTOS -->
  <main class="max-w-7xl mx-auto px-4 pb-16">
    <div id="productsGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="emptyState" class="hidden text-center py-20">
      <div class="mb-6 opacity-30 flex justify-center" id="emptyIcon">
        <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
      </div>
      <h3 class="text-xl font-bold text-gray-600 mb-2">Nenhum produto nesta categoria ainda</h3>
      <p class="text-gray-400 mb-6">Seja o primeiro a adicionar um produto!</p>

    </div>
  </main>

  <!-- BLOG -->
  <section id="blog" class="max-w-7xl mx-auto px-4 py-16">
    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-12">
      <div>
        <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Blog TeckHome</span>
        <h2 class="text-3xl font-black text-gray-900 mb-2">Artigos e Guias de Compra</h2>
        <p class="text-gray-500 max-w-xl">Conteúdo especializado para ajudar você a fazer a melhor escolha antes de comprar.</p>
      </div>
    </div>
    <div id="blogGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="noBlog" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-newspaper text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium mb-2">Nenhum artigo publicado ainda</p>

    </div>
  </section>

  <!-- EQUIPE TECKHOME -->
  <section id="equipe-teckhome" class="py-20 px-4" style="background: linear-gradient(135deg, #f8faff 0%, #eef2ff 50%, #f0f9ff 100%);">
    <div class="max-w-4xl mx-auto">

      <!-- Header editorial -->
      <div class="text-center mb-12">
        <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-4">Editorial</span>
        <h2 class="text-3xl md:text-4xl font-black text-gray-900 mb-3">Sobre a Equipe TeckHome</h2>
        <div class="w-16 h-1 bg-indigo-600 rounded-full mx-auto"></div>
      </div>

      <!-- Card principal da equipe -->
      <div class="bg-white rounded-3xl shadow-xl border border-indigo-50 overflow-hidden" style="box-shadow: 0 20px 60px rgba(99,102,241,0.12);">

        <!-- Top accent bar -->
        <div class="h-1.5 w-full" style="background: linear-gradient(90deg, #6366f1, #818cf8, #38bdf8, #6366f1); background-size: 200% 100%; animation: gradientMove 4s linear infinite;"></div>

        <div class="p-8 md:p-10">
          <div class="flex flex-col md:flex-row items-center md:items-start gap-8">

            <!-- Avatar / Logo identidade -->
            <div class="flex-shrink-0">
              <div class="relative">
                <div class="w-28 h-28 rounded-2xl flex items-center justify-center shadow-lg" style="background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #1e3a5f 100%);">
                  <div class="text-center">
                    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                    <div class="text-white text-xs font-bold tracking-wide">TECH</div>
                  </div>
                </div>
                <!-- Badge verificado -->
                <div class="absolute -bottom-2 -right-2 w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center shadow-md border-2 border-white">
                  <i class="fas fa-check text-white text-xs"></i>
                </div>
              </div>
            </div>

            <!-- Conteúdo editorial -->
            <div class="flex-1 text-center md:text-left">
              <div class="flex flex-col md:flex-row items-center md:items-start gap-3 mb-4">
                <div>
                  <h3 class="text-2xl font-black text-gray-900">Equipe TeckHome</h3>
                  <div class="flex items-center justify-center md:justify-start gap-2 mt-1">
                    <span class="inline-flex items-center gap-1 text-xs text-indigo-600 font-semibold bg-indigo-50 px-3 py-1 rounded-full">
                      <i class="fas fa-shield-alt text-xs"></i> Portal Verificado
                    </span>
                    <span class="inline-flex items-center gap-1 text-xs text-emerald-600 font-semibold bg-emerald-50 px-3 py-1 rounded-full">
                      <span class="w-1.5 h-1.5 bg-emerald-500 rounded-full" style="animation: pulse 2s infinite;"></span> Ativo
                    </span>
                  </div>
                </div>
              </div>

              <p class="text-gray-600 text-base leading-relaxed mb-6">
                A Equipe TeckHome reúne conteúdos, análises e recomendações de produtos voltados para tecnologia, casa e utilidades do dia a dia. Nosso objetivo é ajudar consumidores a fazer escolhas mais inteligentes através de reviews organizados, comparativos e conteúdos informativos.
              </p>

              <!-- Stats da equipe -->
              <div class="grid grid-cols-3 gap-4">
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">7</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Categorias</div>
                </div>
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="text-xl font-black text-indigo-600">100%</div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Imparcial</div>
                </div>
                <div class="text-center p-3 bg-gray-50 rounded-2xl border border-gray-100">
                  <div class="flex justify-center"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
                  <div class="text-xs text-gray-500 font-medium mt-0.5">Mercado BR</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pilares editoriais -->
          <div class="mt-10 pt-8 border-t border-gray-100">
            <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-5">Nossos Pilares</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="flex items-start gap-3 p-4 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-300 transition-all">
                <div class="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-search text-indigo-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Análise Técnica</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Reviews baseados em dados e avaliações reais de mercado</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-blue-50 rounded-2xl border border-blue-100 hover:border-blue-300 transition-all">
                <div class="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-balance-scale text-blue-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Comparativos</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Comparações honestas para facilitar sua decisão de compra</div>
                </div>
              </div>
              <div class="flex items-start gap-3 p-4 bg-sky-50 rounded-2xl border border-sky-100 hover:border-sky-300 transition-all">
                <div class="w-9 h-9 bg-sky-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-home text-sky-600 text-sm"></i>
                </div>
                <div>
                  <div class="font-bold text-gray-800 text-sm">Foco no Lar</div>
                  <div class="text-gray-500 text-xs mt-0.5 leading-relaxed">Especialistas em tecnologia, eletrodomésticos e utilidades</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  </section>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white py-8 px-4 mt-8">
    <div class="max-w-7xl mx-auto flex justify-between items-center flex-wrap gap-4">
      <span class="font-black text-lg">Teck<span class="text-indigo-400">Home</span> Store</span>
      <p class="text-gray-500 text-sm">© 2026 TeckHome Store</p>
    </div>
  </footer>

  <script>
    const CATEGORY_ID = '${categoryId}'
    let allProducts = []
    let category = null
    let currentFilter = 'all'
    let currentSearch = ''

    // SVGs por categoria (mesmos da home)
    const CAT_SVGS = {
      'eletronicos': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M6 8h.01M9 8h6"/></svg>',
      'eletrodomesticos': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><rect x="3" y="9" width="18" height="13" rx="1"/><path d="M8 9v13M16 9v13"/></svg>',
      'ferramentas': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
      'refrigeracao': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07L19.07 4.93"/><circle cx="12" cy="12" r="3"/></svg>',
      'cama-mesa': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20M6 8v9"/><rect x="6" y="5" width="6" height="3" rx="1"/></svg>',
      'ventilacao': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 9c0-3-1.5-6-3-6s-2 2.5-2 4c0 2.5 2 4 5 3"/><path d="M14.6 13.5c2.6 1.5 5.4 1.8 6.4.3s-.5-4-2.5-5c-2.2-1.2-4.5-.4-5.5 2.5"/><path d="M9.4 13.5C6.8 15 4 15.3 3 13.8s.5-4 2.5-5c2.2-1.2 4.5-.4 5.5 2.5"/></svg>',
      'jardim': '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22V12M12 12C12 7 7 4 3 6c0 5 4 8 9 6M12 12c0-5 5-8 9-6-1 5-5 8-9 6"/></svg>'
    }
    function getCatSvgCp(catId, color) {
      const svg = CAT_SVGS[catId] || '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>'
      return svg.replace(/<svg /, \`<svg stroke="\${color}" \`)
    }

    // Funções de análise compartilhadas
    function generateAnalysisCp(product) {
      const analyses = [
        'Produto se destaca pelo excelente custo-benefício e avaliações positivas de compradores reais. Nossa equipe analisou os pontos técnicos e confirma: é uma escolha sólida para quem busca qualidade sem pagar caro.',
        'Depois de avaliar as principais opções disponíveis, este produto chama atenção pela consistência de desempenho e pelo acabamento acima da média. Ideal para quem não abre mão de qualidade.',
        'Nossa análise confirma o que os consumidores já dizem: robusto, funcional e bem avaliado. A combinação de durabilidade e preço justo o coloca entre os favoritos da categoria.',
        'Quer fazer uma compra inteligente? Este é um dos produtos que nossa equipe recomenda com confiança. Avaliações reais apontam alta satisfação e baixo índice de devoluções.',
        'Para quem busca o melhor sem abrir mão da qualidade, este produto é uma das opções mais bem avaliadas hoje. Nossa análise confirma: vale cada centavo investido.'
      ]
      return analyses[product.title.length % analyses.length]
    }

    function generateProsContrasCp(product) {
      const prosList = [
        ['Excelente custo-benefício', 'Durabilidade comprovada', 'Fácil de usar e instalar', 'Ótima relação qualidade × preço'],
        ['Alta qualidade de acabamento', 'Desempenho no uso diário', 'Design moderno e funcional', 'Boa reputação no mercado'],
        ['Entre os mais vendidos', 'Avaliações positivas verificadas', 'Suporte técnico acessível', 'Produto com garantia'],
        ['Entrega rápida e segura', 'Compatibilidade ampla', 'Material de qualidade superior', 'Tecnologia atualizada'],
        ['Eficiência acima da média', 'Economia a longo prazo', 'Recomendado por especialistas', 'Melhor opção da faixa']
      ]
      const contrasList = [
        ['Preço pode variar por demanda', 'Estoque limitado em datas especiais'],
        ['Pode requerer adaptador em instalações antigas', 'Estoque pode esgotar rapidamente'],
        ['Manual apenas em português', 'Cores limitadas'],
        ['Frete pode variar por região', 'Não inclui acessórios extras'],
        ['Prazo de entrega varia', 'Alta demanda — compre logo']
      ]
      const idx = product.title.length % prosList.length
      return { pros: prosList[idx], contras: contrasList[idx] }
    }

    function getCostBenefitCp(product) {
      const score = 70 + ((product.title.length * 7 + (product.store || '').length * 3) % 28)
      const stars = Math.round(score / 20)
      return { score, stars }
    }

    function openProductModalCp(productId) {
      const product = allProducts.find(p => p.id === productId)
      if (!product) return
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=600\`
      const { pros, contras } = generateProsContrasCp(product)
      const { score, stars } = getCostBenefitCp(product)
      const analysis = generateAnalysisCp(product)

      const modal = document.getElementById('productModalCp')
      document.getElementById('modalContentCp').innerHTML = \`
        <div class="flex flex-col md:flex-row max-h-[90vh] overflow-y-auto">
          <!-- Imagem -->
          <div class="md:w-2/5 flex-shrink-0 relative bg-gray-50">
            <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-64 md:h-full object-cover" style="min-height:260px;max-height:420px;" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=600'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent pointer-events-none"></div>
            \${product.featured ? '<div class="absolute top-3 left-3 bg-gradient-to-r from-yellow-400 to-orange-400 text-white text-xs font-bold px-3 py-1 rounded-xl shadow-lg flex items-center gap-1"><svg width="10" height="10" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Destaque</div>' : ''}
          </div>
          <!-- Conteúdo -->
          <div class="flex-1 flex flex-col">
            <div class="p-5 pb-3 border-b border-gray-100">
              <h2 class="text-base font-black text-gray-900 leading-tight mb-3">\${product.title}</h2>
              <div class="flex items-center gap-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-3 border border-indigo-100">
                <div class="text-center">
                  <div class="text-2xl font-black text-indigo-600">\${score}</div>
                  <div class="text-xs text-gray-400">/ 100</div>
                </div>
                <div class="flex-1">
                  <div class="text-xs font-bold text-indigo-700 mb-1">Custo-Benefício TeckHome</div>
                  <div class="flex gap-0.5">\${Array.from({length:5},(_,i)=>'<svg width="14" height="14" viewBox="0 0 24 24" fill="'+(i<stars?'#f59e0b':'#d1d5db')+'"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>').join('')}</div>
                  <div class="w-full bg-gray-200 rounded-full h-1.5 mt-1.5"><div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-1.5 rounded-full" style="width:\${score}%"></div></div>
                </div>
              </div>
            </div>
            <div class="p-5 pb-3">
              <div class="flex items-center gap-2 mb-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                <span class="text-xs font-bold text-indigo-700 uppercase tracking-wider">Análise Editorial</span>
              </div>
              <p class="text-gray-600 text-sm leading-relaxed">\${analysis}</p>
            </div>
            <div class="px-5 pb-4 grid grid-cols-2 gap-3">
              <div class="bg-green-50 rounded-xl p-3 border border-green-100">
                <div class="flex items-center gap-1.5 mb-2">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span class="text-xs font-black text-green-700 uppercase tracking-wide">Pontos Fortes</span>
                </div>
                <ul class="space-y-1.5">\${pros.map(p => \`<li class="flex items-start gap-1.5 text-xs text-green-800"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M20 6L9 17l-5-5"/></svg>\${p}</li>\`).join('')}</ul>
              </div>
              <div class="bg-amber-50 rounded-xl p-3 border border-amber-100">
                <div class="flex items-center gap-1.5 mb-2">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                  <span class="text-xs font-black text-amber-700 uppercase tracking-wide">Atenção</span>
                </div>
                <ul class="space-y-1.5">\${contras.map(c => \`<li class="flex items-start gap-1.5 text-xs text-amber-800"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5" stroke-linecap="round" class="flex-shrink-0 mt-0.5"><path d="M12 8v4M12 16h.01"/></svg>\${c}</li>\`).join('')}</ul>
              </div>
            </div>
            <div class="p-5 pt-2 mt-auto border-t border-gray-100">
              <div class="flex items-center gap-2 mb-3">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span class="text-xs text-gray-400">Análise independente · Equipe TeckHome</span>
              </div>
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer sponsored"
                class="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white font-black py-4 px-6 rounded-2xl transition-all shadow-lg text-sm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                Ver Preço
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </a>
            </div>
          </div>
        </div>
      \`
      modal.classList.remove('hidden')
      document.body.style.overflow = 'hidden'
    }

    function closeProductModalCp() {
      document.getElementById('productModalCp').classList.add('hidden')
      document.body.style.overflow = ''
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeProductModalCp() })

    function createProductCard(product) {
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1 shadow">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="white"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=400\`
      const { score } = getCostBenefitCp(product)
      return \`
        <div class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col cursor-pointer" data-id="\${product.id}" onclick="openProductModalCp('\${product.id}')">
          <div class="relative">
            <div class="h-52 overflow-hidden bg-gray-50">
              <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-full object-cover hover:scale-105 transition-transform duration-300" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=400'">
            </div>
            \${featuredBadge}
            <!-- Overlay lupa -->
            <div class="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
              <div class="bg-white/90 rounded-2xl px-4 py-2 flex items-center gap-2 shadow-lg">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <span class="text-xs font-bold text-indigo-700">Ver Análise</span>
              </div>
            </div>
          </div>
          <div class="p-4 flex flex-col flex-1 gap-2">
            <h3 class="font-bold text-gray-800 text-sm leading-tight line-clamp-2">\${product.title}</h3>
            <!-- Score compacto -->
            <div class="flex items-center gap-2">
              <div class="flex-1 bg-gray-100 rounded-full h-1.5">
                <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-1.5 rounded-full" style="width:\${score}%"></div>
              </div>
              <span class="text-xs font-black text-indigo-600">\${score}/100</span>
              <span class="text-xs text-gray-400">custo-benef.</span>
            </div>
            <div class="flex items-center gap-2 mt-auto pt-1">
              <span class="trust-badge text-xs font-semibold text-green-700 px-2 py-1 rounded-lg flex items-center gap-1">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Verificado
              </span>
              <button onclick="event.stopPropagation();openProductModalCp('\${product.id}')" class="ml-auto flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors">
                Ver Análise
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
            </div>
          </div>
        </div>
      \`
    }

    function renderProducts() {
      let filtered = [...allProducts]
      
      if (currentFilter === 'featured') {
        filtered = filtered.filter(p => p.featured)
      }
      
      if (currentSearch) {
        const q = currentSearch.toLowerCase()
        filtered = filtered.filter(p => 
          p.title.toLowerCase().includes(q) || 
          (p.description && p.description.toLowerCase().includes(q))
        )
      }
      
      const grid = document.getElementById('productsGrid')
      const emptyState = document.getElementById('emptyState')
      
      if (filtered.length === 0) {
        grid.innerHTML = ''
        emptyState.classList.remove('hidden')
        if (category) document.getElementById('emptyIcon').innerHTML = getCatSvgCp(category.id, category.color).replace('width="26" height="26"','width="70" height="70"')
      } else {
        emptyState.classList.add('hidden')
        grid.innerHTML = filtered.map(createProductCard).join('')
      }
    }

    function filterProducts(filter) {
      currentFilter = filter
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active-filter', 'border-indigo-600', 'bg-indigo-600', 'text-white')
        btn.classList.add('border-gray-200', 'text-gray-600')
      })
      const btn = document.getElementById(\`filter-\${filter}\`)
      btn.classList.add('active-filter', 'border-indigo-600', 'bg-indigo-600', 'text-white')
      btn.classList.remove('border-gray-200', 'text-gray-600')
      renderProducts()
    }

    function filterBySearch(value) {
      currentSearch = value
      renderProducts()
    }

    async function init() {
      // Carregar categoria
      const catRes = await fetch('/api/categories')
      const categories = await catRes.json()
      category = categories.find(c => c.id === CATEGORY_ID)
      
      if (category) {
        document.title = \`TeckHome Store - \${category.name}\`
        document.getElementById('categoryHeader').innerHTML = \`
          <div class="max-w-7xl mx-auto">
            <nav class="text-sm text-gray-400 mb-3 flex items-center gap-2">
              <a href="/" class="hover:text-indigo-600 transition-colors">Início</a>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
              <span class="text-gray-600 font-medium">\${category.name}</span>
            </nav>
            <div class="flex items-center gap-4">
              <div class="w-14 h-14 rounded-2xl flex items-center justify-center" style="background: linear-gradient(135deg, \${category.color}18, \${category.color}35); border: 2px solid \${category.color}40;">
                \${getCatSvgCp(category.id, category.color)}
              </div>
              <div>
                <h1 class="text-3xl font-black text-gray-900">\${category.name}</h1>
                <p class="text-gray-500">\${category.description}</p>
              </div>
            </div>
          </div>
        \`
      }

      // Carregar produtos
      const prodRes = await fetch(\`/api/products/\${CATEGORY_ID}\`)
      allProducts = await prodRes.json()
      renderProducts()

      // Carregar comparativos da categoria
      loadComparativosSection()
    }

    async function loadComparativosSection() {
      try {
        const res = await fetch('/api/comparativos')
        const all = await res.json()
        const catComps = all.filter(c => c.status === 'active' && c.category === CATEGORY_ID)
        if (!catComps.length) return
        const section = document.getElementById('comparativosSection')
        if (section) section.classList.remove('hidden')
        const container = document.getElementById('comparativosContainer')
        if (!container) return
        container.innerHTML = catComps.map(cmp => renderComparativoCard(cmp)).join('')
      } catch(e) { console.log('Comparativos não carregados:', e) }
    }

    function renderComparativoCard(cmp) {
      const prods = cmp.products || []
      if (prods.length < 2) return ''

      const starsHtml = (r) => {
        const v = parseFloat(r) || 0
        return Array.from({length:5}, (_,i) =>
          \`<svg width="12" height="12" viewBox="0 0 24 24" fill="\${i<Math.floor(v)?'#f59e0b':i<v?'#fcd34d':'#e5e7eb'}" xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>\`
        ).join('')
      }

      const badgeHtml = (p) => {
        if (p.badge === 'best') return '<span style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:white;font-size:10px;font-weight:800;padding:3px 8px;border-radius:20px;letter-spacing:0.3px;white-space:nowrap;">🏆 MELHOR ESCOLHA</span>'
        if (p.badge === 'costbenefit') return '<span style="background:linear-gradient(135deg,#059669,#10b981);color:white;font-size:10px;font-weight:800;padding:3px 8px;border-radius:20px;letter-spacing:0.3px;white-space:nowrap;">💚 CUSTO-BENEFÍCIO</span>'
        return ''
      }

      const faqHtml = cmp.faq ? \`
        <div style="background:#f8fafc;border-radius:16px;padding:20px;margin-top:24px;">
          <h4 style="font-size:15px;font-weight:800;color:#1f2937;margin:0 0 14px;display:flex;align-items:center;gap:8px;"><span style="color:#6366f1;">❓</span> Perguntas Frequentes</h4>
          \${cmp.faq.split(/\\n\\n+/).map(block => {
            const lines = block.split('\\n')
            const q = lines[0]||''
            const a = lines.slice(1).join(' ')
            return q ? \`<div style="margin-bottom:12px;"><p style="font-size:13px;font-weight:700;color:#374151;margin:0 0 3px;">\${q}</p><p style="font-size:13px;color:#6b7280;margin:0;">\${a}</p></div>\` : ''
          }).join('')}
        </div>
      \` : ''

      return \`
        <div style="background:white;border-radius:20px;border:1px solid #e5e7eb;padding:24px;margin-bottom:24px;box-shadow:0 2px 12px rgba(0,0,0,0.06);" itemscope itemtype="https://schema.org/ItemList">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <span style="background:linear-gradient(135deg,#7c3aed,#6366f1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:18px;">⚖️</span>
            <span style="font-size:11px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:1px;background:#f3f0ff;padding:3px 10px;border-radius:20px;">Comparativo</span>
          </div>
          <h2 style="font-size:20px;font-weight:900;color:#111827;margin:0 0 6px;line-height:1.3;" itemprop="name">\${cmp.title}</h2>
          \${cmp.summary ? \`<p style="font-size:14px;color:#6b7280;margin:0 0 20px;line-height:1.7;">\${cmp.summary}</p>\` : ''}

          <!-- TABELA COMPARATIVA -->
          <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:20px;">
            <table style="width:100%;border-collapse:collapse;min-width:480px;">
              <thead>
                <tr style="background:linear-gradient(135deg,#f3f0ff,#ede9fe);">
                  <th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:700;color:#7c3aed;border-radius:10px 0 0 10px;">Produto</th>
                  <th style="padding:10px 14px;text-align:center;font-size:12px;font-weight:700;color:#7c3aed;">Preço</th>
                  <th style="padding:10px 14px;text-align:center;font-size:12px;font-weight:700;color:#7c3aed;">Avaliação</th>
                  <th style="padding:10px 14px;text-align:center;font-size:12px;font-weight:700;color:#7c3aed;border-radius:0 10px 10px 0;">Ação</th>
                </tr>
              </thead>
              <tbody>
                \${prods.map((p, i) => \`
                  <tr style="border-bottom:1px solid #f3f4f6;\${p.badge==='best'?'background:linear-gradient(90deg,#faf5ff,white);':''}" itemscope itemtype="https://schema.org/Product">
                    <td style="padding:12px 14px;">
                      <div style="display:flex;align-items:center;gap:10px;">
                        \${p.image ? \`<img src="\${p.image}" alt="\${p.name}" style="width:44px;height:44px;object-fit:cover;border-radius:10px;border:1px solid #f3f4f6;" loading="lazy">\` : \`<div style="width:44px;height:44px;background:#f3f0ff;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;">📦</div>\`}
                        <div>
                          <p style="font-size:13px;font-weight:800;color:#1f2937;margin:0 0 3px;line-height:1.3;" itemprop="name">\${p.name || 'Produto'}</p>
                          <div>\${badgeHtml(p)}</div>
                        </div>
                      </div>
                    </td>
                    <td style="padding:12px 14px;text-align:center;">
                      <span style="font-size:14px;font-weight:800;color:#059669;">\${p.price || '—'}</span>
                    </td>
                    <td style="padding:12px 14px;text-align:center;">
                      <div style="display:flex;justify-content:center;gap:1px;">\${starsHtml(p.rating)}</div>
                      \${p.rating ? \`<span style="font-size:11px;color:#6b7280;">\${p.rating}/5</span>\` : '<span style="font-size:11px;color:#9ca3af;">—</span>'}
                    </td>
                    <td style="padding:12px 14px;text-align:center;">
                      \${p.affiliateUrl ? \`<a href="\${p.affiliateUrl}" target="_blank" rel="noopener sponsored" style="display:inline-block;background:\${p.badge==='best'?'linear-gradient(135deg,#7c3aed,#6366f1)':'#6366f1'};color:white;font-size:12px;font-weight:700;padding:7px 14px;border-radius:10px;text-decoration:none;white-space:nowrap;">Ver Preço</a>\` : '<span style="font-size:12px;color:#9ca3af;">—</span>'}
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>

          <!-- CARDS COM PRÓS E CONTRAS -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px;">
            \${prods.map(p => \`
              <div style="background:#fafafa;border:1px solid #f3f4f6;border-radius:14px;padding:14px;position:relative;\${p.badge==='best'?'border-color:#c4b5fd;background:linear-gradient(135deg,#faf5ff,#fafafa);':''}">
                \${p.badge ? \`<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);white-space:nowrap;">\${badgeHtml(p)}</div>\` : ''}
                <p style="font-size:12px;font-weight:800;color:#1f2937;margin:\${p.badge?'10px':'0'} 0 10px;text-align:center;line-height:1.3;">\${p.name || 'Produto'}</p>
                \${(p.pros||[]).length ? \`
                  <div style="margin-bottom:8px;">
                    \${(p.pros||[]).map(pro => \`<div style="font-size:11px;color:#059669;display:flex;align-items:flex-start;gap:5px;margin-bottom:3px;"><span style="flex-shrink:0;margin-top:1px;">✓</span><span>\${pro}</span></div>\`).join('')}
                  </div>
                \` : ''}
                \${(p.cons||[]).length ? \`
                  <div>
                    \${(p.cons||[]).map(con => \`<div style="font-size:11px;color:#ef4444;display:flex;align-items:flex-start;gap:5px;margin-bottom:3px;"><span style="flex-shrink:0;margin-top:1px;">✗</span><span>\${con}</span></div>\`).join('')}
                  </div>
                \` : ''}
              </div>
            \`).join('')}
          </div>

          \${cmp.conclusion ? \`
            <div style="background:linear-gradient(135deg,#f3f0ff,#ede9fe);border-radius:14px;padding:16px;margin-bottom:16px;border-left:4px solid #7c3aed;">
              <p style="font-size:13px;font-weight:700;color:#7c3aed;margin:0 0 6px;display:flex;align-items:center;gap:6px;">💡 Conclusão</p>
              <p style="font-size:14px;color:#374151;margin:0;line-height:1.7;">\${cmp.conclusion}</p>
            </div>
          \` : ''}

          \${faqHtml}
        </div>
      \`
    }

    init()
  </script>

  <!-- SEÇÃO COMPARATIVOS -->
  <section id="comparativosSection" class="hidden" aria-label="Comparativo de produtos">
    <div class="max-w-7xl mx-auto px-4 pb-12">
      <div class="flex items-center gap-3 mb-6 pt-2">
        <div style="background:linear-gradient(135deg,#7c3aed,#6366f1);border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;color:white;font-size:16px;">⚖️</div>
        <div>
          <h2 class="text-xl font-black text-gray-900 leading-tight">Comparativo entre Produtos Similares</h2>
          <p class="text-sm text-gray-500">Análise completa para você decidir melhor</p>
        </div>
      </div>
      <div id="comparativosContainer"></div>
    </div>
  </section>

  <!-- MODAL DE PRODUTO (categoria) -->
  <div id="productModalCp" class="hidden fixed inset-0 z-[999] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);" onclick="if(event.target===this)closeProductModalCp()">
    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden relative" style="max-height:92vh;">
      <button onclick="closeProductModalCp()" class="absolute top-4 right-4 z-10 w-9 h-9 bg-white/90 hover:bg-red-50 border border-gray-200 hover:border-red-200 rounded-xl flex items-center justify-center transition-all shadow-sm">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <div id="modalContentCp"></div>
    </div>
  </div>

</body>
</html>`
}

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>TeckHome Store - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; box-sizing: border-box; }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .toast { position: fixed; bottom: 24px; right: 24px; z-index: 9999; transform: translateX(200%); transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
    .toast.show { transform: translateX(0); }
    .card-admin { transition: all 0.2s ease; }
    .card-admin:hover { box-shadow: 0 8px 25px rgba(0,0,0,0.1); }
    .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #6366f1; border-radius: 50%; width: 24px; height: 24px; animation: spin 0.8s linear infinite; display: inline-block; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    /* Fix FontAwesome icons */
    i.fas, i.fa, i.far { font-family: 'Font Awesome 6 Free' !important; font-weight: 900 !important; font-style: normal !important; }
    i.fab { font-family: 'Font Awesome 6 Brands' !important; font-weight: 400 !important; font-style: normal !important; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- Toast -->
  <div id="toast" class="toast">
    <div id="toastInner" class="bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72">
      <i id="toastIcon" class="text-xl"></i>
      <span id="toastMsg" class="font-medium text-gray-800 text-sm"></span>
    </div>
  </div>

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Painel Admin</span>
          </div>
        </a>
        <div class="flex items-center gap-3">
          <a href="/" class="text-sm font-medium text-gray-600 hover:text-indigo-600 flex items-center gap-1">
            <i class="fas fa-eye text-xs"></i> Ver Site
          </a>
          <a href="/admin/logout" class="flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 text-sm font-semibold px-4 py-2 rounded-xl transition-colors border border-red-200">
            <i class="fas fa-sign-out-alt text-xs"></i> Sair
          </a>
        </div>
      </div>
    </div>
  </nav>

  <!-- TABS NAV -->
  <div class="max-w-7xl mx-auto px-4 pt-6 pb-0">
    <div class="flex gap-2 border-b border-gray-200">
      <button onclick="switchTab('produtos')" id="tab-produtos"
        class="tab-btn px-5 py-3 text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-box text-xs"></i> Produtos
      </button>
      <button onclick="switchTab('blog')" id="tab-blog"
        class="tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-indigo-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-newspaper text-xs"></i> Blog / Artigos
      </button>
      <button onclick="switchTab('destaques')" id="tab-destaques"
        class="tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-yellow-500 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-star text-xs"></i> Destaques
        <span id="destaquesCount" class="hidden bg-yellow-400 text-white text-xs font-black rounded-full w-5 h-5 flex items-center justify-center">0</span>
      </button>
      <button onclick="switchTab('comparativos')" id="tab-comparativos"
        class="tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-purple-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-balance-scale text-xs"></i> Comparativos
      </button>
      <button onclick="switchTab('precos')" id="tab-precos"
        class="tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-green-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-tags text-xs"></i> Compare Preços
      </button>
      <button onclick="switchTab('config')" id="tab-config"
        class="tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-gray-600 -mb-px transition-all flex items-center gap-2">
        <i class="fas fa-cog text-xs"></i> Config
      </button>
    </div>
  </div>

  <!-- TAB: PRODUTOS -->
  <div id="section-produtos" class="max-w-7xl mx-auto px-4 py-8">
    <div class="grid lg:grid-cols-5 gap-8">
      
      <!-- FORMULÁRIO DE ADICIONAR -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-plus-circle text-indigo-600"></i> Adicionar Produto
          </h2>
          <p class="text-gray-400 text-sm mb-6">Cole o link do produto para buscar automaticamente</p>

          <!-- URL Input com auto-fetch -->
          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-2">
              Link do Produto <span class="text-red-500">*</span>
            </label>
            <div class="flex gap-2">
              <input type="url" id="productUrl" placeholder="https://www.amazon.com.br/..." 
                class="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
                onpaste="setTimeout(() => fetchMetadata(), 100)">
              <button onclick="fetchMetadata()" id="fetchBtn"
                class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 whitespace-nowrap">
                <i class="fas fa-magic"></i> Buscar
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">Cole o link e clique em "Buscar" para preencher automaticamente</p>
          </div>

          <!-- Preview da URL -->
          <div id="urlPreview" class="hidden mb-4 p-3 bg-indigo-50 rounded-xl border border-indigo-100 flex items-center gap-3">
            <img id="previewImg" src="" alt="" class="w-14 h-14 object-cover rounded-lg border border-indigo-200 bg-white">
            <div class="flex-1 min-w-0">
              <p id="previewTitle" class="text-sm font-bold text-gray-800 line-clamp-2"></p>
              <p id="previewStore" class="text-xs text-indigo-600 mt-0.5 font-medium"></p>
            </div>
          </div>

          <!-- Campos do formulário -->
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Categoria <span class="text-red-500">*</span></label>
              <select id="categoryId" class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white transition-all">
                <option value="">Selecione uma categoria...</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Título do Produto <span class="text-red-500">*</span></label>
              <input type="text" id="productTitle" placeholder="Ex: Smart TV Samsung 55' 4K" 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">
                Descrição do Vendedor
                <span class="text-xs text-gray-400 font-normal ml-1">(só para coleta — não exibida)</span>
              </label>
              <textarea id="productDesc" rows="2" placeholder="Cole a descrição original do produto aqui para referência..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none transition-all bg-amber-50 border-amber-200"></textarea>
              <p class="text-xs text-amber-600 mt-1 flex items-center gap-1"><i class="fas fa-info-circle"></i> Esta descrição é apenas para referência interna. O site exibirá uma análise persuasiva gerada automaticamente.</p>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Loja <span class="text-red-500">*</span></label>
                <input type="text" id="productStore" placeholder="Amazon, Mercado Livre..." 
                  class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Avaliação (0-5)</label>
                <div class="flex items-center gap-2 mt-3">
                  <input type="range" id="productRating" min="0" max="5" step="0.5" value="0" 
                    class="flex-1 accent-indigo-600"
                    oninput="document.getElementById('ratingValue').textContent = this.value + '★'">
                  <span id="ratingValue" class="text-yellow-500 font-bold text-sm w-10 text-right">0★</span>
                </div>
              </div>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">URL da Imagem (opcional)</label>
              <input type="url" id="productImage" placeholder="https://..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div class="flex items-center gap-3 p-3 bg-yellow-50 rounded-xl border border-yellow-100">
              <input type="checkbox" id="productFeatured" class="w-4 h-4 accent-indigo-600">
              <div>
                <label for="productFeatured" class="text-sm font-semibold text-gray-700 cursor-pointer">
                  ⭐ Marcar como Destaque
                </label>
                <p class="text-xs text-gray-400">Aparece na seção de destaques da página inicial</p>
              </div>
            </div>
          </div>

          <button onclick="addProduct()" id="addBtn"
            class="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm">
            <i class="fas fa-plus"></i> Adicionar Produto
          </button>
        </div>
      </div>

      <!-- LISTA DE PRODUTOS -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-black text-gray-900 flex items-center gap-2">
            <i class="fas fa-list text-indigo-600"></i> Produtos Cadastrados
          </h2>
          <select id="filterCategory" onchange="loadProducts()" class="text-sm px-3 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 bg-white">
            <option value="">Todas as categorias</option>
          </select>
        </div>

        <div id="productsList" class="space-y-3">
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
        </div>

        <div id="emptyAdmin" class="hidden text-center py-16 text-gray-400">
          <i class="fas fa-box-open text-5xl mb-4 opacity-30"></i>
          <p class="text-lg font-medium">Nenhum produto cadastrado ainda</p>
          <p class="text-sm mt-1">Use o formulário ao lado para adicionar produtos</p>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: DESTAQUES -->
  <div id="section-destaques" class="hidden max-w-7xl mx-auto px-4 py-8">

    <!-- Cabeçalho da seção -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-black text-gray-900 flex items-center gap-3">
          <span class="w-10 h-10 bg-yellow-400 rounded-xl flex items-center justify-center shadow-md">
            <i class="fas fa-star text-white text-sm"></i>
          </span>
          Gerenciar Destaques
        </h2>
        <p class="text-gray-400 text-sm mt-1 ml-13">Produtos em destaque aparecem na seção principal da página inicial</p>
      </div>
      <button onclick="loadDestaques()" class="flex items-center gap-2 text-sm text-indigo-600 hover:text-indigo-800 font-semibold bg-indigo-50 hover:bg-indigo-100 px-4 py-2 rounded-xl transition-colors border border-indigo-200">
        <i class="fas fa-sync text-xs"></i> Atualizar
      </button>
    </div>

    <!-- Info banner -->
    <div class="bg-yellow-50 border border-yellow-200 rounded-2xl p-4 mb-6 flex items-start gap-3">
      <i class="fas fa-lightbulb text-yellow-500 mt-0.5 flex-shrink-0"></i>
      <div class="text-sm text-yellow-800">
        <strong>Como funciona:</strong> Os produtos marcados com ⭐ aparecem automaticamente na seção "Em Destaque" da página inicial. Você pode ativar ou desativar o destaque de qualquer produto aqui, ou ao adicionar um novo produto marque a opção <em>"Marcar como Destaque"</em> no formulário da aba Produtos.
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-8">

      <!-- COLUNA ESQUERDA: Produtos em destaque -->
      <div>
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-black text-gray-800 flex items-center gap-2">
            <i class="fas fa-star text-yellow-400"></i>
            Em Destaque
            <span id="featuredCountBadge" class="text-xs bg-yellow-400 text-white font-black px-2 py-0.5 rounded-full">0</span>
          </h3>
        </div>

        <div id="featuredList" class="space-y-3">
          <div class="shimmer rounded-2xl h-20"></div>
          <div class="shimmer rounded-2xl h-20"></div>
        </div>

        <div id="emptyFeatured" class="hidden text-center py-14 bg-white rounded-2xl border-2 border-dashed border-yellow-200">
          <div class="text-5xl mb-3">⭐</div>
          <p class="text-gray-500 font-semibold">Nenhum produto em destaque</p>
          <p class="text-gray-400 text-sm mt-1">Selecione produtos na coluna ao lado para destacar</p>
        </div>
      </div>

      <!-- COLUNA DIREITA: Todos os produtos (para adicionar ao destaque) -->
      <div>
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-black text-gray-800 flex items-center gap-2">
            <i class="fas fa-box text-indigo-400"></i>
            Todos os Produtos
          </h3>
          <select id="destaqueCatFilter" onchange="loadDestaques()" class="text-sm px-3 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 bg-white">
            <option value="">Todas as categorias</option>
          </select>
        </div>

        <div id="allProductsForFeatured" class="space-y-3">
          <div class="shimmer rounded-2xl h-20"></div>
          <div class="shimmer rounded-2xl h-20"></div>
          <div class="shimmer rounded-2xl h-20"></div>
        </div>

        <div id="emptyAllProducts" class="hidden text-center py-14 bg-white rounded-2xl border-2 border-dashed border-gray-200">
          <div class="text-5xl mb-3">📦</div>
          <p class="text-gray-500 font-semibold">Nenhum produto cadastrado</p>
          <p class="text-gray-400 text-sm mt-1">Adicione produtos na aba Produtos primeiro</p>
        </div>
      </div>

    </div>
  </div>

  <!-- TAB: BLOG -->
  <div id="section-blog" class="hidden max-w-7xl mx-auto px-4 py-8">
    <!-- HEADER DA ABA BLOG COM BOTÃO HOME -->
    <div class="flex items-center justify-between mb-6 pb-4 border-b border-gray-100">
      <div class="flex items-center gap-3">
        <a href="/" title="Voltar à página inicial" class="w-9 h-9 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center transition-all border border-indigo-200 shadow-sm" style="text-decoration:none;">
          <i class="fas fa-home text-sm"></i>
        </a>
        <div>
          <h1 class="text-2xl font-black text-gray-900 flex items-center gap-2">
            <i class="fas fa-newspaper text-indigo-600"></i> Blog
          </h1>
          <p class="text-xs text-gray-400 leading-none mt-0.5">Gerencie os artigos publicados no site</p>
        </div>
      </div>
      <a href="/" class="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-indigo-600 transition-colors bg-gray-50 hover:bg-indigo-50 px-4 py-2 rounded-xl border border-gray-200 hover:border-indigo-200" style="text-decoration:none;">
        <i class="fas fa-arrow-left text-xs"></i> Voltar ao Site
      </a>
    </div>
    <div class="grid lg:grid-cols-5 gap-8">

      <!-- FORMULÁRIO DE CRIAR ARTIGO -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-pen-nib text-indigo-600"></i> Criar Artigo do Blog
          </h2>
          <p class="text-gray-400 text-sm mb-5">Cole o link de um produto e gere automaticamente um artigo persuasivo para o blog</p>

          <!-- Passo 1: URL do produto -->
          <div class="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 mb-5">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-6 h-6 bg-indigo-600 text-white text-xs font-black rounded-full flex items-center justify-center">1</span>
              <span class="text-sm font-bold text-gray-800">Cole o link do produto</span>
            </div>
            <div class="flex gap-2">
              <input type="url" id="articleProductUrl" placeholder="https://www.amazon.com.br/..." 
                class="flex-1 px-3 py-2.5 rounded-xl border border-indigo-200 text-sm outline-none focus:border-indigo-400 bg-white transition-all"
                onpaste="setTimeout(() => fetchArticleMetadata(), 100)">
              <button onclick="fetchArticleMetadata()" id="fetchArticleBtn"
                class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap">
                <i class="fas fa-magic text-xs"></i> Buscar
              </button>
            </div>
          </div>

          <!-- Preview do produto buscado -->
          <div id="articlePreview" class="hidden mb-4 p-3 bg-green-50 rounded-xl border border-green-200 flex items-center gap-3">
            <img id="articlePreviewImg" src="" alt="" class="w-14 h-14 object-cover rounded-lg bg-white flex-shrink-0">
            <div class="flex-1 min-w-0">
              <p id="articlePreviewTitle" class="text-sm font-bold text-gray-800 line-clamp-2"></p>
              <p id="articlePreviewStore" class="text-xs text-green-600 mt-0.5 font-medium"></p>
            </div>
          </div>

          <!-- Passo 2: Gerar artigo -->
          <div class="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-5">
            <div class="flex items-center gap-2 mb-3">
              <span class="w-6 h-6 bg-purple-600 text-white text-xs font-black rounded-full flex items-center justify-center">2</span>
              <span class="text-sm font-bold text-gray-800">Gere o artigo automaticamente</span>
            </div>
            <button onclick="generateArticle()" id="generateBtn"
              class="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 text-sm shadow-md hover:shadow-lg">
              <i class="fas fa-robot text-xs"></i> Gerar Artigo Persuasivo
            </button>
            <p class="text-xs text-purple-500 mt-2 text-center">Usa técnicas de copywriting para maximizar conversões</p>
          </div>

          <!-- Campos editáveis do artigo -->
          <div id="articleFields" class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Título do Artigo <span class="text-red-500">*</span></label>
              <input type="text" id="articleTitle" placeholder="Título será gerado automaticamente..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Resumo / Excerpt <span class="text-red-500">*</span></label>
              <textarea id="articleExcerpt" rows="4" placeholder="Resumo persuasivo do artigo..."
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none transition-all"></textarea>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Categoria</label>
                <select id="articleCategory" class="w-full px-3 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                  <option value="Eletrônicos" data-icon="📱">📱 Eletrônicos</option>
                  <option value="Eletrodomésticos" data-icon="🏠">🏠 Eletrodomésticos</option>
                  <option value="Ferramentas" data-icon="🔧">🔧 Ferramentas</option>
                  <option value="Refrigeração" data-icon="❄️">❄️ Refrigeração</option>
                  <option value="Cama e Mesa" data-icon="🛏️">🛏️ Cama e Mesa</option>
                  <option value="Ventilação" data-icon="💨">💨 Ventilação</option>
                  <option value="Jardim" data-icon="🌱">🌱 Jardim</option>
                  <option value="Geral" data-icon="📝">📝 Geral</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Tempo de leitura</label>
                <select id="articleReadTime" class="w-full px-3 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white">
                  <option>4 min</option>
                  <option>5 min</option>
                  <option selected>6 min</option>
                  <option>7 min</option>
                  <option>8 min</option>
                  <option>10 min</option>
                </select>
              </div>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Palavras-chave SEO</label>
              <input type="text" id="articleKeywords" placeholder="palavra-chave 1, palavra-chave 2..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Imagem do artigo (URL)</label>
              <input type="url" id="articleImage" placeholder="https://images.unsplash.com/..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>
          </div>

          <button onclick="publishArticle()" id="publishBtn"
            class="w-full mt-5 bg-green-600 hover:bg-green-700 text-white font-bold py-4 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm">
            <i class="fas fa-paper-plane"></i> Publicar Artigo no Blog
          </button>
        </div>
      </div>

      <!-- LISTA DE ARTIGOS -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-black text-gray-900 flex items-center gap-2">
            <i class="fas fa-newspaper text-indigo-600"></i> Artigos Publicados
          </h2>
          <button onclick="loadArticles()" class="text-sm text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1">
            <i class="fas fa-sync text-xs"></i> Atualizar
          </button>
        </div>

        <!-- Artigos estáticos info -->
        <div class="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-4 text-sm text-blue-700 flex items-start gap-3">
          <i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
          <div>
            <strong>Artigos automáticos:</strong> O site já exibe 7 artigos editoriais fixos sobre eletrônicos, eletrodomésticos, refrigeração, ferramentas, cama e mesa, jardim e ventilação. Abaixo estão os artigos extras criados neste painel.
          </div>
        </div>

        <div id="articlesList" class="space-y-3">
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
        </div>

        <div id="emptyArticles" class="hidden text-center py-16 text-gray-400">
          <i class="fas fa-newspaper text-5xl mb-4 opacity-30"></i>
          <p class="text-lg font-medium">Nenhum artigo criado ainda</p>
          <p class="text-sm mt-1">Use o formulário ao lado para criar artigos a partir de produtos</p>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: COMPARATIVOS -->
  <div id="section-comparativos" class="hidden max-w-7xl mx-auto px-4 py-8">
    <div class="grid lg:grid-cols-5 gap-8">
      <!-- FORMULÁRIO -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-balance-scale text-purple-600"></i> <span id="cmpFormTitle">Novo Comparativo</span>
          </h2>
          <p class="text-gray-400 text-sm mb-5">Compare produtos similares e gere textos com IA</p>
          <input type="hidden" id="cmpEditId" value="">

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Título do Comparativo</label>
            <input id="cmpTitle" type="text" placeholder="Ex: Melhor Aspirador de Pó 2025" class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100 transition-all">
          </div>

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Categoria</label>
            <select id="cmpCategory" class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all">
              <option value="">Selecione a categoria...</option>
            </select>
          </div>

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Produtos Comparados</label>
            <div id="cmpProductsList" class="space-y-2 min-h-12 bg-gray-50 rounded-xl p-3 border border-dashed border-gray-200">
              <p class="text-gray-400 text-xs text-center py-2">Nenhum produto adicionado</p>
            </div>
            <select id="cmpAddProductSelect" class="w-full mt-2 px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all">
              <option value="">+ Adicionar produto ao comparativo...</option>
            </select>
            <button onclick="addCmpProduct()" class="w-full mt-2 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-sm font-semibold py-2 rounded-xl transition-all flex items-center justify-center gap-2">
              <i class="fas fa-plus-circle"></i> Adicionar Produto
            </button>
          </div>

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Status</label>
            <select id="cmpStatus" class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all">
              <option value="active">Ativo (visível no site)</option>
              <option value="inactive">Inativo (oculto)</option>
            </select>
          </div>

          <div class="mb-5">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Observações (interno)</label>
            <textarea id="cmpNotes" rows="2" placeholder="Notas internas sobre este comparativo..." class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all resize-none"></textarea>
          </div>

          <!-- Gerador de IA -->
          <div class="border-t border-gray-100 pt-4 mb-4">
            <p class="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2"><i class="fas fa-robot text-purple-500"></i> Gerador de Texto com IA</p>
            <button onclick="generateComparativoAI()" id="btnGenAI" class="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 shadow-md">
              <i class="fas fa-magic"></i> Gerar Textos Automáticos
            </button>
            <p class="text-xs text-gray-400 mt-1 text-center">Cria título, resumo, conclusão, FAQ e meta descrição SEO</p>
          </div>

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Resumo</label>
            <textarea id="cmpSummary" rows="3" placeholder="Resumo gerado pela IA ou escrito manualmente..." class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all resize-none"></textarea>
          </div>
          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Conclusão</label>
            <textarea id="cmpConclusion" rows="3" placeholder="Conclusão e recomendação final..." class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all resize-none"></textarea>
          </div>
          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">FAQ (perguntas frequentes)</label>
            <textarea id="cmpFaq" rows="4" placeholder="P: Qual produto é melhor?&#10;R: Depende do seu perfil..." class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all resize-none"></textarea>
          </div>
          <div class="mb-5">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Meta Descrição SEO</label>
            <textarea id="cmpMetaDesc" rows="2" placeholder="Descrição para mecanismos de busca (máx 160 caracteres)..." class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-purple-400 transition-all resize-none"></textarea>
          </div>

          <div class="flex gap-2">
            <button onclick="saveComparativo()" id="btnSaveCmp" class="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2">
              <i class="fas fa-save"></i> Salvar
            </button>
            <button onclick="openNewComparativo()" class="px-4 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl transition-all">
              <i class="fas fa-plus"></i> Novo
            </button>
          </div>
        </div>
      </div>

      <!-- LISTA -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-black text-gray-900">Comparativos Cadastrados</h2>
          <span id="cmpCount" class="bg-purple-100 text-purple-700 text-xs font-bold px-3 py-1 rounded-full">0 total</span>
        </div>
        <div id="cmpList" class="space-y-4">
          <div class="text-center py-16 text-gray-400">
            <i class="fas fa-balance-scale text-5xl mb-4 opacity-30"></i>
            <p class="text-lg font-medium">Carregando comparativos...</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: COMPARE PREÇOS -->
  <div id="section-precos" class="hidden max-w-7xl mx-auto px-4 py-8">
    <div class="grid lg:grid-cols-5 gap-8">
      <!-- FORMULÁRIO -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-tags text-green-600"></i> <span id="pcFormTitle">Nova Comparação</span>
          </h2>
          <p class="text-gray-400 text-sm mb-5">Configure a seção de comparação de preços para artigos</p>
          <input type="hidden" id="pcEditId" value="">

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Nome do Produto <span class="text-red-500">*</span></label>
            <input id="pcProductName" type="text" placeholder="Ex: Furadeira Bosch GSB 450" class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-green-400 focus:ring-2 focus:ring-green-100 transition-all">
            <p class="text-xs text-gray-400 mt-1">Usado para gerar links automáticos nos marketplaces</p>
          </div>

          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Slug do Artigo <span class="text-red-500">*</span></label>
            <input id="pcSlug" type="text" placeholder="Ex: guia-eletronicos" class="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-green-400 transition-all">
            <p class="text-xs text-gray-400 mt-1">Identificador da URL do artigo onde aparecerá</p>
          </div>

          <div class="mb-4 flex items-center justify-between">
            <div>
              <label class="block text-sm font-semibold text-gray-700">Status</label>
              <p class="text-xs text-gray-400">Exibir no artigo</p>
            </div>
            <div class="flex gap-3">
              <select id="pcActive" class="px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-green-400 transition-all">
                <option value="true">Ativo</option>
                <option value="false">Inativo</option>
              </select>
            </div>
          </div>

          <!-- Gerenciar lojas -->
          <div class="border-t border-gray-100 pt-4 mb-4">
            <div class="flex items-center justify-between mb-3">
              <p class="text-sm font-bold text-gray-700">Lojas / Marketplaces</p>
              <button onclick="addPcStore()" class="bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 text-xs font-bold px-3 py-1.5 rounded-xl transition-all flex items-center gap-1.5">
                <i class="fas fa-plus"></i> Adicionar
              </button>
            </div>
            <div id="pcStoresList" class="space-y-2 min-h-12 bg-gray-50 rounded-xl p-3 border border-dashed border-gray-200">
              <p class="text-gray-400 text-xs text-center py-2">Clique em "Adicionar" para incluir marketplaces</p>
            </div>
          </div>

          <!-- Geração automática de links -->
          <div class="mb-5 bg-green-50 rounded-xl p-3 border border-green-100">
            <p class="text-xs font-bold text-green-700 mb-2 flex items-center gap-1.5"><i class="fas fa-magic"></i> Links automáticos por marketplace</p>
            <div class="flex flex-wrap gap-1.5">
              <button onclick="addPcStorePreset('amazon')" class="bg-white border border-gray-200 hover:border-orange-300 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all text-gray-700 hover:text-orange-600">+ Amazon</button>
              <button onclick="addPcStorePreset('mercadolivre')" class="bg-white border border-gray-200 hover:border-yellow-400 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all text-gray-700 hover:text-yellow-600">+ Mercado Livre</button>
              <button onclick="addPcStorePreset('shopee')" class="bg-white border border-gray-200 hover:border-red-400 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all text-gray-700 hover:text-red-600">+ Shopee</button>
              <button onclick="addPcStorePreset('magalu')" class="bg-white border border-gray-200 hover:border-blue-400 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all text-gray-700 hover:text-blue-600">+ Magalu</button>
              <button onclick="addPcStorePreset('americanas')" class="bg-white border border-gray-200 hover:border-red-400 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all text-gray-700 hover:text-red-700">+ Americanas</button>
            </div>
          </div>

          <div class="flex gap-2">
            <button onclick="savePriceCompare()" id="btnSavePc" class="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2">
              <i class="fas fa-save"></i> Salvar
            </button>
            <button onclick="openNewPriceCompare()" class="px-4 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-semibold py-3 rounded-xl transition-all">
              <i class="fas fa-plus"></i> Novo
            </button>
          </div>
        </div>
      </div>

      <!-- LISTA -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-black text-gray-900">Comparações Cadastradas</h2>
          <span id="pcCount" class="bg-green-100 text-green-700 text-xs font-bold px-3 py-1 rounded-full">0 total</span>
        </div>
        <div id="pcList" class="space-y-4">
          <div class="text-center py-16 text-gray-400">
            <i class="fas fa-tags text-5xl mb-4 opacity-30"></i>
            <p class="text-lg font-medium">Carregando...</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: CONFIG -->
  <div id="section-config" class="hidden max-w-7xl mx-auto px-4 py-8">
    <div class="max-w-2xl mx-auto">
      <h2 class="text-2xl font-black text-gray-900 mb-6 flex items-center gap-3">
        <i class="fas fa-cog text-gray-600"></i> Configurações do Site
      </h2>

      <!-- Modo Manutenção -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <h3 class="text-lg font-black text-gray-900 flex items-center gap-2">
              <i class="fas fa-hard-hat text-orange-500"></i> Modo Manutenção
            </h3>
            <p class="text-gray-500 text-sm mt-1 leading-relaxed">
              Quando ativado, visitantes verão uma tela de manutenção ao acessar o site. O painel admin permanece acessível normalmente.
            </p>
            <div id="maintenanceStatusBadge" class="mt-3">
              <span class="bg-gray-100 text-gray-500 text-xs font-bold px-3 py-1.5 rounded-full">Verificando...</span>
            </div>
          </div>
          <button id="btnToggleMaintenance" onclick="toggleMaintenance()" class="ml-4 flex-shrink-0 px-5 py-3 bg-gray-100 text-gray-600 hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 border border-gray-200 font-bold text-sm rounded-xl transition-all flex items-center gap-2">
            <i class="fas fa-power-off"></i> Alternar
          </button>
        </div>

        <div class="mt-4 bg-orange-50 border border-orange-100 rounded-xl p-4">
          <p class="text-orange-700 text-xs font-medium flex items-start gap-2">
            <i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
            <span>O modo manutenção é ativado automaticamente ao acessar o painel admin e desativado ao fazer logout. Você também pode alternar manualmente aqui.</span>
          </p>
        </div>
      </div>

      <!-- Info do Sistema -->
      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h3 class="text-base font-black text-gray-900 mb-4 flex items-center gap-2">
          <i class="fas fa-info-circle text-blue-500"></i> Informações do Sistema
        </h3>
        <div class="space-y-3 text-sm">
          <div class="flex justify-between py-2 border-b border-gray-50">
            <span class="text-gray-500">Plataforma</span>
            <span class="font-semibold text-gray-700">Cloudflare Pages</span>
          </div>
          <div class="flex justify-between py-2 border-b border-gray-50">
            <span class="text-gray-500">Framework</span>
            <span class="font-semibold text-gray-700">Hono + TypeScript</span>
          </div>
          <div class="flex justify-between py-2 border-b border-gray-50">
            <span class="text-gray-500">Storage</span>
            <span class="font-semibold text-gray-700">Cloudflare KV</span>
          </div>
          <div class="flex justify-between py-2">
            <span class="text-gray-500">Versão</span>
            <span class="font-semibold text-gray-700">2.0.0</span>
          </div>
        </div>
        <div class="mt-4 pt-4 border-t border-gray-100">
          <a href="/admin/logout" class="flex items-center gap-2 text-sm font-bold text-red-500 hover:text-red-600 transition-colors">
            <i class="fas fa-sign-out-alt"></i> Fazer Logout do Admin
          </a>
        </div>
      </div>
    </div>
  </div>

  <script>
    let categories = []
    let allProducts = []
    let allArticles = []

    // ======= TABS =======
    function switchTab(tab) {
      ['produtos','blog','destaques','comparativos','precos','config'].forEach(t => {
        const el = document.getElementById('section-' + t)
        if (el) el.classList.toggle('hidden', tab !== t)
      })
      document.getElementById('tab-produtos').className = tab === 'produtos'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-indigo-600 -mb-px transition-all flex items-center gap-2'
      document.getElementById('tab-blog').className = tab === 'blog'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-indigo-600 -mb-px transition-all flex items-center gap-2'
      document.getElementById('tab-destaques').className = tab === 'destaques'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-yellow-500 border-b-2 border-yellow-400 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-yellow-500 -mb-px transition-all flex items-center gap-2'
      document.getElementById('tab-comparativos').className = tab === 'comparativos'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-purple-600 border-b-2 border-purple-500 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-purple-600 -mb-px transition-all flex items-center gap-2'
      document.getElementById('tab-precos').className = tab === 'precos'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-green-600 border-b-2 border-green-500 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-green-600 -mb-px transition-all flex items-center gap-2'
      document.getElementById('tab-config').className = tab === 'config'
        ? 'tab-btn px-5 py-3 text-sm font-bold text-gray-700 border-b-2 border-gray-500 -mb-px transition-all flex items-center gap-2'
        : 'tab-btn px-5 py-3 text-sm font-bold text-gray-400 border-b-2 border-transparent hover:text-gray-600 -mb-px transition-all flex items-center gap-2'
      if (tab === 'blog') loadArticles()
      if (tab === 'destaques') loadDestaques()
      if (tab === 'comparativos') loadComparativos()
      if (tab === 'precos') loadPriceCompareAdmin()
      if (tab === 'config') loadConfig()
    }

    // ======= TOAST =======
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast')
      const icon = document.getElementById('toastIcon')
      const msg = document.getElementById('toastMsg')
      const inner = document.getElementById('toastInner')
      icon.className = type === 'success' ? 'fas fa-check-circle text-green-500 text-xl' :
                       type === 'error'   ? 'fas fa-times-circle text-red-500 text-xl'   :
                       'fas fa-info-circle text-blue-500 text-xl'
      inner.className = \`bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72 \${type === 'success' ? 'border-green-100' : type === 'error' ? 'border-red-100' : 'border-blue-100'}\`
      msg.textContent = message
      toast.classList.add('show')
      setTimeout(() => toast.classList.remove('show'), 3500)
    }

    // ======= PRODUTOS =======
    async function fetchMetadata() {
      const urlEl = document.getElementById('productUrl')
      const url = urlEl ? urlEl.value.trim() : ''
      if (!url) return
      // Validar URL básica antes de enviar
      try { new URL(url) } catch(e) {
        showToast('⚠️ Cole uma URL completa (ex: https://amazon.com.br/...)', 'error')
        return
      }
      const btn = document.getElementById('fetchBtn')
      if (btn) { btn.innerHTML = '<span class="spinner"></span> Buscando...'; btn.disabled = true }
      try {
        const res = await fetch('/api/fetch-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        if (data.title) {
          const titleEl = document.getElementById('productTitle')
          const descEl = document.getElementById('productDesc')
          const imgEl = document.getElementById('productImage')
          const storeEl = document.getElementById('productStore')
          if (titleEl) titleEl.value = data.title
          if (descEl && data.description) descEl.value = data.description
          if (imgEl && data.imageUrl) imgEl.value = data.imageUrl
          if (storeEl && data.store) storeEl.value = data.store
          const preview = document.getElementById('urlPreview')
          if (preview) {
            preview.classList.remove('hidden')
            const previewImg = document.getElementById('previewImg')
            if (previewImg) previewImg.src = data.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(data.title)}&background=6366f1&color=fff&size=100\`
            const previewTitleEl = document.getElementById('previewTitle')
            if (previewTitleEl) previewTitleEl.textContent = data.title
            const previewStoreEl = document.getElementById('previewStore')
            if (previewStoreEl) previewStoreEl.textContent = data.store || ''
          }
          showToast('✅ Dados carregados! Revise e salve.', 'success')
        } else {
          showToast('⚠️ Não foi possível extrair dados. Preencha manualmente.', 'info')
        }
      } catch (e) {
        console.error('fetchMetadata error:', e)
        showToast('⚠️ Erro ao buscar dados. Preencha manualmente.', 'error')
      }
      if (btn) { btn.innerHTML = '<i class="fas fa-magic"></i> Buscar'; btn.disabled = false }
    }

    async function addProduct() {
      const categoryId = document.getElementById('categoryId').value
      const productUrl = document.getElementById('productUrl').value.trim()
      const title = document.getElementById('productTitle').value.trim()
      if (!categoryId) return showToast('Selecione uma categoria!', 'error')
      if (!productUrl) return showToast('URL do produto é obrigatória!', 'error')
      if (!title) return showToast('Título do produto é obrigatório!', 'error')
      const btn = document.getElementById('addBtn')
      btn.innerHTML = '<span class="spinner"></span> Salvando...'
      btn.disabled = true
      try {
        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            categoryId, productUrl, title,
            description: document.getElementById('productDesc').value.trim(),
            imageUrl: document.getElementById('productImage').value.trim(),
            price: '',
            store: document.getElementById('productStore').value.trim(),
            rating: parseFloat(document.getElementById('productRating').value),
            featured: document.getElementById('productFeatured').checked
          })
        })
        const data = await res.json()
        if (data.success) { showToast('Produto adicionado com sucesso!', 'success'); resetForm(); await loadProducts() }
        else showToast(data.error || 'Erro ao adicionar produto', 'error')
      } catch (e) { showToast('Erro de conexão', 'error') }
      btn.innerHTML = '<i class="fas fa-plus"></i> Adicionar Produto'
      btn.disabled = false
    }

    function resetForm() {
      ['productUrl','productTitle','productDesc','productImage','productStore'].forEach(id => document.getElementById(id).value = '')
      document.getElementById('categoryId').value = ''
      document.getElementById('productRating').value = 0
      document.getElementById('ratingValue').textContent = '0★'
      document.getElementById('productFeatured').checked = false
      document.getElementById('urlPreview').classList.add('hidden')
    }

    async function loadProducts() {
      const filterCat = document.getElementById('filterCategory').value
      const url = filterCat ? \`/api/products/\${filterCat}\` : '/api/products'
      const res = await fetch(url)
      allProducts = await res.json()
      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)
      const list = document.getElementById('productsList')
      const empty = document.getElementById('emptyAdmin')
      if (allProducts.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return }
      empty.classList.add('hidden')
      list.innerHTML = allProducts.map(p => {
        const cat = catMap[p.categoryId] || { name: p.categoryId, icon: '📦', color: '#6366f1' }
        const imgSrc = p.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80\`
        return \`
          <div class="card-admin bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4" data-id="\${p.id}">
            <img src="\${imgSrc}" alt="\${p.title}" class="w-16 h-16 rounded-xl object-cover bg-gray-100 flex-shrink-0" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80'">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap mb-1">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium text-white" style="background: \${cat.color}">\${cat.icon} \${cat.name}</span>
                \${p.featured ? '<span class="text-xs px-2 py-0.5 rounded-full font-medium text-white featured-badge">⭐ Destaque</span>' : ''}
                \${p.store ? \`<span class="text-xs text-gray-400 font-medium">\${p.store}</span>\` : ''}
              </div>
              <h3 class="font-bold text-gray-800 text-sm line-clamp-1">\${p.title}</h3>
              <a href="\${p.productUrl}" target="_blank" class="text-xs text-indigo-500 hover:underline truncate max-w-xs block mt-0.5">\${p.productUrl}</a>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button data-action="featured" data-cat="\${p.categoryId}" data-id="\${p.id}"
                class="p-2 rounded-xl border transition-all \${p.featured ? 'bg-yellow-50 border-yellow-200 text-yellow-500' : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-yellow-50 hover:border-yellow-200 hover:text-yellow-500'}"
                title="\${p.featured ? 'Remover destaque' : 'Marcar como destaque'}">
                <i class="fas fa-star text-sm"></i>
              </button>
              <a href="\${p.productUrl}" target="_blank" class="p-2 rounded-xl border bg-indigo-50 border-indigo-200 text-indigo-500 hover:bg-indigo-100 transition-all" title="Abrir produto">
                <i class="fas fa-external-link-alt text-sm"></i>
              </a>
              <button data-action="delete" data-cat="\${p.categoryId}" data-id="\${p.id}"
                class="p-2 rounded-xl border bg-red-50 border-red-200 text-red-400 hover:bg-red-100 transition-all" title="Remover produto">
                <i class="fas fa-trash text-sm"></i>
              </button>
            </div>
          </div>
        \`
      }).join('')
    }

    document.getElementById('productsList').addEventListener('click', async function(e) {
      const btn = e.target.closest('button[data-action]')
      if (!btn) return
      const action = btn.dataset.action, cat = btn.dataset.cat, id = btn.dataset.id
      if (action === 'delete') {
        const found = allProducts.find(p => p.id === id)
        if (!confirm('Remover "' + ((found && found.title) || 'este produto') + '"?')) return
        try {
          const res = await fetch('/api/products/' + cat + '/' + id, { method: 'DELETE' })
          const data = await res.json()
          if (data.success) { showToast('Produto removido!', 'success'); await loadProducts() }
          else showToast(data.error || 'Erro ao remover', 'error')
        } catch { showToast('Erro de conexão', 'error') }
      } else if (action === 'featured') {
        try {
          const res = await fetch('/api/products/' + cat + '/' + id + '/featured', { method: 'PATCH' })
          const data = await res.json()
          if (data.success) { showToast(data.product.featured ? '⭐ Marcado como destaque!' : 'Removido dos destaques', 'success'); await loadProducts() }
        } catch { showToast('Erro de conexão', 'error') }
      }
    })

    // ======= BLOG / ARTIGOS =======
    let articleMetadata = {}

    async function fetchArticleMetadata() {
      const url = document.getElementById('articleProductUrl').value.trim()
      if (!url) return
      const btn = document.getElementById('fetchArticleBtn')
      btn.innerHTML = '<span class="spinner"></span>'
      btn.disabled = true
      try {
        const res = await fetch('/api/fetch-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
        articleMetadata = await res.json()
        articleMetadata.url = url
        const preview = document.getElementById('articlePreview')
        if (articleMetadata.title) {
          preview.classList.remove('hidden')
          document.getElementById('articlePreviewImg').src = articleMetadata.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(articleMetadata.title)}&background=6366f1&color=fff&size=100\`
          document.getElementById('articlePreviewTitle').textContent = articleMetadata.title
          document.getElementById('articlePreviewStore').textContent = articleMetadata.store ? '🛒 ' + articleMetadata.store : ''
          // Auto-preenche campos
          document.getElementById('articleImage').value = articleMetadata.imageUrl || ''
          showToast('Produto encontrado! Agora clique em "Gerar Artigo".', 'success')
        } else {
          showToast('Não foi possível buscar dados. Preencha manualmente.', 'info')
        }
      } catch { showToast('Erro ao buscar dados do produto.', 'error') }
      btn.innerHTML = '<i class="fas fa-magic text-xs"></i> Buscar'
      btn.disabled = false
    }

    function generateArticle() {
      const title = articleMetadata.title || ''
      const store = articleMetadata.store || 'marketplace'
      const desc = articleMetadata.description || ''
      const cat = document.getElementById('articleCategory').value
      const btn = document.getElementById('generateBtn')
      btn.innerHTML = '<span class="spinner"></span> Gerando...'
      btn.disabled = true

      // Gera título SEO persuasivo
      const titleTemplates = [
        \`Vale a pena comprar? Análise completa + tudo que você precisa saber antes de comprar\`,
        \`Review honesto: descubra por que este produto está entre os mais recomendados de 2026\`,
        \`Guia de compra: análise técnica, prós, contras e veredicto final\`,
        \`Analisamos a fundo — veja o que encontramos antes de recomendar\`,
        \`O que ninguém te conta sobre este produto: análise imparcial da Equipe TeckHome\`
      ]
      const tIdx = (title.length + cat.length) % titleTemplates.length
      const generatedTitle = title
        ? \`\${title.substring(0, 50)}: \${titleTemplates[tIdx]}\`
        : titleTemplates[tIdx]

      // Gera excerpt persuasivo longo (copywriting)
      const excerptTemplates = [
        \`Todo consumidor sabe a frustração de comprar um produto empolgado pelas fotos e descrições, e descobrir depois que ele não entrega o que prometia. Por isso, nossa equipe foi além das especificações técnicas e analisou os pontos que realmente importam: durabilidade, custo-benefício real, facilidade de uso e o que os compradores verificados dizem sobre este produto. O resultado desta análise pode mudar sua decisão de compra — e te fazer economizar tempo e dinheiro. Antes de finalizar sua compra na \${store}, leia nossa avaliação completa.\`,
        \`Quando um produto chama atenção no mercado, nossa missão é ir além do marketing e descobrir o que ele realmente vale. Depois de analisar dezenas de avaliações reais, comparar com alternativas da mesma categoria e estudar as especificações técnicas com olho crítico, chegamos a uma conclusão que vai surpreender você. Se você está cogitando adquirir este produto, não perca tempo: nossa análise resume tudo que você precisa saber para comprar com total segurança — sem arrependimentos e sem desperdício de dinheiro.\`,
        \`Você está prestes a tomar uma decisão de compra importante. E nós entendemos que, com tantas opções no mercado e promessas exageradas das marcas, é difícil saber em quem confiar. Foi exatamente por isso que criamos esta análise: para te dar clareza, objetividade e confiança. Avaliamos este produto nos critérios que realmente importam para quem vai usá-lo no dia a dia — e nosso veredicto é baseado em dados reais, não em especificações de marketing. Leia até o final antes de tomar sua decisão.\`,
        \`Há uma grande diferença entre um produto que parece bom e um produto que realmente é bom. Nossa equipe passou horas pesquisando, comparando e analisando este item disponível na \${store} para te dar uma resposta honesta: vale a pena? A resposta pode te surpreender. Reunimos nesta análise os pontos fortes, os pontos de atenção, e o perfil exato do comprador que vai se beneficiar deste produto — para que você tome a decisão mais inteligente possível.\`,
        \`Se você chegou até aqui, é porque está levando sua decisão de compra a sério. E isso é exatamente o que a Equipe TeckHome valoriza. Nossa missão é separar o joio do trigo em \${cat} — e este produto passou pelo nosso processo de análise rigoroso. Avaliamos tudo: qualidade de construção, desempenho no uso real, custo-benefício e reputação na \${store}. Confira nosso relatório completo e descubra se este produto merece um lugar no seu carrinho de compras.\`
      ]
      const eIdx = (title.length + store.length) % excerptTemplates.length
      const generatedExcerpt = excerptTemplates[eIdx]

      // Gera keywords SEO
      const catKeywords = {
        'Eletrônicos': 'eletrônicos, tecnologia, review eletrônico, melhor celular, smartphone',
        'Eletrodomésticos': 'eletrodomésticos, casa, review eletrodoméstico, cozinha, utilidades',
        'Ferramentas': 'ferramentas elétricas, bricolagem, faça você mesmo, ferramentas casa',
        'Refrigeração': 'ar condicionado, refrigeração, clima, conforto térmico, BTU',
        'Cama e Mesa': 'cama, mesa, roupa de cama, conforto, lar',
        'Ventilação': 'ventilador, ventilação, circulador de ar, conforto',
        'Jardim': 'jardim, plantas, ferramentas jardim, área externa',
        'Geral': 'produtos, review, análise, compras'
      }
      const baseKw = catKeywords[cat] || catKeywords['Geral']
      const shortTitle = title.substring(0, 30).toLowerCase().replace(/[^a-z0-9\s]/g, '')
      const generatedKeywords = \`\${shortTitle}, review \${shortTitle}, vale a pena \${shortTitle}, \${store} \${shortTitle}, \${baseKw}\`

      document.getElementById('articleTitle').value = generatedTitle
      document.getElementById('articleExcerpt').value = generatedExcerpt
      document.getElementById('articleKeywords').value = generatedKeywords

      btn.innerHTML = '<i class="fas fa-robot text-xs"></i> Gerar Artigo Persuasivo'
      btn.disabled = false
      showToast('Artigo gerado com copywriting persuasivo! Revise e publique.', 'success')
    }

    async function publishArticle() {
      const title = document.getElementById('articleTitle').value.trim()
      const excerpt = document.getElementById('articleExcerpt').value.trim()
      if (!title) return showToast('Título do artigo é obrigatório!', 'error')
      if (!excerpt) return showToast('Resumo do artigo é obrigatório!', 'error')

      const catSelect = document.getElementById('articleCategory')
      const catOpt = catSelect.options[catSelect.selectedIndex]
      const catIcon = catOpt.getAttribute('data-icon') || '📝'

      const btn = document.getElementById('publishBtn')
      btn.innerHTML = '<span class="spinner"></span> Publicando...'
      btn.disabled = true

      try {
        const res = await fetch('/api/articles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            excerpt,
            category: catSelect.value,
            categoryIcon: catIcon,
            image: document.getElementById('articleImage').value.trim(),
            productUrl: articleMetadata.url || document.getElementById('articleProductUrl').value.trim(),
            store: articleMetadata.store || '',
            readTime: document.getElementById('articleReadTime').value,
            keywords: document.getElementById('articleKeywords').value.trim()
          })
        })
        const data = await res.json()
        if (data.success) {
          showToast('✅ Artigo publicado no blog!', 'success')
          resetArticleForm()
          await loadArticles()
        } else {
          showToast(data.error || 'Erro ao publicar artigo', 'error')
        }
      } catch { showToast('Erro de conexão', 'error') }

      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Publicar Artigo no Blog'
      btn.disabled = false
    }

    function resetArticleForm() {
      articleMetadata = {}
      document.getElementById('articleProductUrl').value = ''
      document.getElementById('articleTitle').value = ''
      document.getElementById('articleExcerpt').value = ''
      document.getElementById('articleKeywords').value = ''
      document.getElementById('articleImage').value = ''
      document.getElementById('articlePreview').classList.add('hidden')
    }

    async function loadArticles() {
      try {
        const res = await fetch('/api/articles')
        allArticles = res.ok ? await res.json() : []
      } catch { allArticles = [] }

      const list = document.getElementById('articlesList')
      const empty = document.getElementById('emptyArticles')

      if (allArticles.length === 0) {
        list.innerHTML = ''
        empty.classList.remove('hidden')
        return
      }

      empty.classList.add('hidden')
      list.innerHTML = allArticles.map(art => \`
        <div class="card-admin bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4">
          <div class="w-16 h-16 rounded-xl overflow-hidden bg-indigo-50 flex-shrink-0 flex items-center justify-center text-2xl">
            \${art.image ? \`<img src="\${art.image}" alt="" class="w-full h-full object-cover">\` : art.categoryIcon || '📝'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">\${art.categoryIcon || ''} \${art.category || 'Geral'}</span>
              <span class="text-xs text-gray-400"><i class="fas fa-clock text-xs"></i> \${art.readTime || '5 min'}</span>
            </div>
            <h3 class="font-bold text-gray-800 text-sm line-clamp-2">\${art.title}</h3>
            <p class="text-xs text-gray-400 mt-0.5">\${new Date(art.createdAt).toLocaleDateString('pt-BR')}</p>
          </div>
          <button onclick="deleteArticle('\${art.id}')" class="p-2 rounded-xl border bg-red-50 border-red-200 text-red-400 hover:bg-red-100 transition-all flex-shrink-0" title="Remover artigo">
            <i class="fas fa-trash text-sm"></i>
          </button>
        </div>
      \`).join('')
    }

    async function deleteArticle(id) {
      const art = allArticles.find(a => a.id === id)
      if (!confirm('Remover artigo "' + ((art && art.title) || 'este artigo').substring(0, 50) + '"?')) return
      try {
        const res = await fetch('/api/articles/' + id, { method: 'DELETE' })
        const data = await res.json()
        if (data.success) { showToast('Artigo removido!', 'success'); await loadArticles() }
        else showToast(data.error || 'Erro ao remover', 'error')
      } catch { showToast('Erro de conexão', 'error') }
    }

    // ======= DESTAQUES =======
    async function loadDestaques() {
      const catFilter = document.getElementById('destaqueCatFilter').value
      const url = catFilter ? \`/api/products/\${catFilter}\` : '/api/products'
      const res = await fetch(url)
      const products = res.ok ? await res.json() : []

      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)

      // Lista de destaques
      const featured = products.filter(p => p.featured)
      const featuredList = document.getElementById('featuredList')
      const emptyFeatured = document.getElementById('emptyFeatured')
      const badge = document.getElementById('featuredCountBadge')
      const tabBadge = document.getElementById('destaquesCount')

      badge.textContent = featured.length
      if (featured.length > 0) {
        tabBadge.textContent = featured.length
        tabBadge.classList.remove('hidden')
      } else {
        tabBadge.classList.add('hidden')
      }

      if (featured.length === 0) {
        featuredList.innerHTML = ''
        emptyFeatured.classList.remove('hidden')
      } else {
        emptyFeatured.classList.add('hidden')
        featuredList.innerHTML = featured.map(p => {
          const cat = catMap[p.categoryId] || { name: p.categoryId, icon: '📦', color: '#6366f1' }
          const img = p.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=f59e0b&color=fff&size=80\`
          return \`
            <div class="bg-white rounded-2xl border-2 border-yellow-200 shadow-sm p-4 flex items-center gap-4 card-admin">
              <div class="relative flex-shrink-0">
                <img src="\${img}" alt="\${p.title}" class="w-14 h-14 rounded-xl object-cover bg-gray-100" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=f59e0b&color=fff&size=80'">
                <span class="absolute -top-1.5 -right-1.5 text-base">⭐</span>
              </div>
              <div class="flex-1 min-w-0">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium text-white" style="background:\${cat.color}">\${cat.icon} \${cat.name}</span>
                <h4 class="font-bold text-gray-800 text-sm line-clamp-1 mt-1">\${p.title}</h4>
                \${p.store ? \`<p class="text-xs text-gray-400 mt-0.5">\${p.store}</p>\` : ''}
              </div>
              <button onclick="toggleDestaqueProd('\${p.categoryId}','\${p.id}')" class="flex-shrink-0 flex items-center gap-1.5 bg-yellow-50 hover:bg-red-50 border border-yellow-200 hover:border-red-200 text-yellow-600 hover:text-red-500 text-xs font-bold px-3 py-2 rounded-xl transition-all">
                <i class="fas fa-star"></i> Remover
              </button>
            </div>
          \`
        }).join('')
      }

      // Lista de todos os produtos
      const allList = document.getElementById('allProductsForFeatured')
      const emptyAll = document.getElementById('emptyAllProducts')

      if (products.length === 0) {
        allList.innerHTML = ''
        emptyAll.classList.remove('hidden')
      } else {
        emptyAll.classList.add('hidden')
        allList.innerHTML = products.map(p => {
          const cat = catMap[p.categoryId] || { name: p.categoryId, icon: '📦', color: '#6366f1' }
          const img = p.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80\`
          const isFeatured = p.featured
          return \`
            <div class="bg-white rounded-2xl border \${isFeatured ? 'border-yellow-300 bg-yellow-50' : 'border-gray-100'} shadow-sm p-4 flex items-center gap-4 card-admin">
              <img src="\${img}" alt="\${p.title}" class="w-14 h-14 rounded-xl object-cover bg-gray-100 flex-shrink-0" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80'">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1 flex-wrap">
                  <span class="text-xs px-2 py-0.5 rounded-full font-medium text-white" style="background:\${cat.color}">\${cat.icon} \${cat.name}</span>
                  \${isFeatured ? '<span class="text-xs bg-yellow-400 text-white px-2 py-0.5 rounded-full font-bold">⭐ Destaque</span>' : ''}
                </div>
                <h4 class="font-bold text-gray-800 text-sm line-clamp-1">\${p.title}</h4>
                \${p.store ? \`<p class="text-xs text-gray-400 mt-0.5">\${p.store}</p>\` : ''}
              </div>
              <button onclick="toggleDestaqueProd('\${p.categoryId}','\${p.id}')" class="flex-shrink-0 flex items-center gap-1.5 \${isFeatured ? 'bg-yellow-400 hover:bg-yellow-500 text-white border-yellow-400' : 'bg-gray-50 hover:bg-yellow-50 text-gray-400 hover:text-yellow-500 border-gray-200 hover:border-yellow-300'} border text-xs font-bold px-3 py-2 rounded-xl transition-all whitespace-nowrap">
                <i class="fas fa-star"></i>\${isFeatured ? ' Destacado' : ' Destacar'}
              </button>
            </div>
          \`
        }).join('')
      }
    }

    async function toggleDestaqueProd(categoryId, productId) {
      try {
        const res = await fetch(\`/api/products/\${categoryId}/\${productId}/featured\`, { method: 'PATCH' })
        const data = await res.json()
        if (data.success) {
          showToast(data.product.featured ? '⭐ Produto adicionado aos destaques!' : 'Produto removido dos destaques', data.product.featured ? 'success' : 'info')
          await loadDestaques()
        } else {
          showToast('Erro ao atualizar destaque', 'error')
        }
      } catch { showToast('Erro de conexão', 'error') }
    }

    // ======= CONFIG / MAINTENANCE =======
    async function loadConfig() {
      await updateMaintenanceStatus()
    }

    async function updateMaintenanceStatus() {
      try {
        const res = await fetch('/api/admin/maintenance')
        const data = await res.json()
        const badge = document.getElementById('maintenanceStatusBadge')
        const btn = document.getElementById('btnToggleMaintenance')
        if (data.maintenance) {
          badge.innerHTML = '<span class="bg-orange-100 text-orange-700 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5"><i class="fas fa-hard-hat"></i> Modo Manutenção ATIVO — site offline para visitantes</span>'
          btn.className = 'ml-4 flex-shrink-0 px-5 py-3 bg-orange-500 text-white hover:bg-orange-600 border border-orange-500 font-bold text-sm rounded-xl transition-all flex items-center gap-2'
          btn.innerHTML = '<i class="fas fa-power-off"></i> Desativar Manutenção'
        } else {
          badge.innerHTML = '<span class="bg-green-100 text-green-700 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5"><i class="fas fa-check-circle"></i> Site Online — visitantes podem acessar normalmente</span>'
          btn.className = 'ml-4 flex-shrink-0 px-5 py-3 bg-gray-100 text-gray-600 hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 border border-gray-200 font-bold text-sm rounded-xl transition-all flex items-center gap-2'
          btn.innerHTML = '<i class="fas fa-power-off"></i> Ativar Manutenção'
        }
      } catch(e) {
        console.error('Erro ao buscar status manutenção', e)
      }
    }

    async function toggleMaintenance() {
      try {
        const btn = document.getElementById('btnToggleMaintenance')
        btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>'
        btn.disabled = true
        const res = await fetch('/api/admin/maintenance', { method: 'POST' })
        const data = await res.json()
        showToast(data.maintenance ? 'Modo manutenção ATIVADO — site offline' : 'Site voltou ao ar!', data.maintenance ? 'info' : 'success')
        await updateMaintenanceStatus()
        btn.disabled = false
      } catch(e) {
        showToast('Erro ao alternar manutenção', 'error')
        document.getElementById('btnToggleMaintenance').disabled = false
      }
    }

    // ======= COMPARATIVOS =======
    let cmpProducts = [] // produtos no comparativo atual

    async function loadComparativos() {
      const list = document.getElementById('cmpList')
      const countEl = document.getElementById('cmpCount')
      list.innerHTML = '<div class="text-center py-8 text-gray-400"><span class="spinner"></span><p class="mt-3 text-sm">Carregando...</p></div>'
      try {
        const res = await fetch('/api/comparativos')
        const data = await res.json()
        countEl.textContent = (data.length || 0) + ' total'
        if (!data.length) {
          window._allComparativos = []
          list.innerHTML = '<div class="text-center py-16 text-gray-400"><i class="fas fa-balance-scale text-5xl mb-4 opacity-30"></i><p class="text-lg font-medium">Nenhum comparativo cadastrado ainda</p><p class="text-sm mt-1">Use o formulário ao lado para criar o primeiro</p></div>'
          return
        }
        window._allComparativos = data
        list.innerHTML = data.map(cmp => \`
          <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 card-admin">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-bold px-2 py-0.5 rounded-full \${cmp.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">\${cmp.status === 'active' ? 'Ativo' : 'Inativo'}</span>
                  <span class="text-xs text-gray-400">\${cmp.category || 'Sem categoria'}</span>
                </div>
                <h3 class="font-black text-gray-900 text-base leading-tight truncate">\${cmp.title}</h3>
                <p class="text-xs text-gray-400 mt-1">\${(cmp.products || []).length} produto(s) comparado(s)</p>
                <div class="flex flex-wrap gap-1.5 mt-2">
                  \${(cmp.products || []).slice(0,3).map(p => \`<span class="bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded-lg font-medium">\${p.name ? p.name.substring(0,25)+'...' : p.id}</span>\`).join('')}
                </div>
              </div>
              <div class="flex flex-col gap-2 flex-shrink-0">
                <button onclick="editComparativo('\${cmp.id}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5">
                  <i class="fas fa-edit"></i> Editar
                </button>
                <button onclick="deleteComparativo('\${cmp.id}')" class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5">
                  <i class="fas fa-trash"></i> Excluir
                </button>
              </div>
            </div>
          </div>
        \`).join('')
      } catch(e) {
        list.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fas fa-times-circle text-3xl mb-3"></i><p>Erro ao carregar comparativos</p></div>'
      }
    }

    function openNewComparativo() {
      document.getElementById('cmpEditId').value = ''
      document.getElementById('cmpFormTitle').textContent = 'Novo Comparativo'
      document.getElementById('cmpTitle').value = ''
      document.getElementById('cmpCategory').value = ''
      document.getElementById('cmpStatus').value = 'active'
      document.getElementById('cmpSummary').value = ''
      document.getElementById('cmpConclusion').value = ''
      document.getElementById('cmpFaq').value = ''
      document.getElementById('cmpMetaDesc').value = ''
      document.getElementById('cmpNotes').value = ''
      cmpProducts = []
      renderCmpProducts()
      populateCmpProductSelect()
    }

    async function editComparativo(id) {
      try {
        const res = await fetch('/api/comparativos/' + id)
        const cmp = await res.json()
        document.getElementById('cmpEditId').value = cmp.id
        document.getElementById('cmpFormTitle').textContent = 'Editar Comparativo'
        document.getElementById('cmpTitle').value = cmp.title || ''
        document.getElementById('cmpCategory').value = cmp.category || ''
        document.getElementById('cmpStatus').value = cmp.status || 'active'
        document.getElementById('cmpSummary').value = cmp.summary || ''
        document.getElementById('cmpConclusion').value = cmp.conclusion || ''
        document.getElementById('cmpFaq').value = cmp.faq || ''
        document.getElementById('cmpMetaDesc').value = cmp.metaDesc || ''
        document.getElementById('cmpNotes').value = cmp.notes || ''
        cmpProducts = cmp.products || []
        renderCmpProducts()
        populateCmpProductSelect()
        switchTab('comparativos')
        document.getElementById('cmpTitle').scrollIntoView({ behavior: 'smooth', block: 'center' })
        showToast('Comparativo carregado para edição', 'info')
      } catch(e) {
        showToast('Erro ao carregar comparativo', 'error')
      }
    }

    function renderCmpProducts() {
      const container = document.getElementById('cmpProductsList')
      if (!cmpProducts.length) {
        container.innerHTML = '<p class="text-gray-400 text-xs text-center py-2">Nenhum produto adicionado</p>'
        return
      }
      container.innerHTML = cmpProducts.map((p, i) => \`
        <div class="bg-white border border-gray-200 rounded-xl p-3 flex items-start gap-2" id="cmpProd-\${i}">
          <div class="flex flex-col gap-1 flex-shrink-0">
            <button onclick="moveCmpProduct(\${i},-1)" class="w-6 h-5 bg-gray-100 hover:bg-gray-200 rounded text-gray-500 text-xs transition-all" \${i===0?'disabled':''}>▲</button>
            <button onclick="moveCmpProduct(\${i},1)" class="w-6 h-5 bg-gray-100 hover:bg-gray-200 rounded text-gray-500 text-xs transition-all" \${i===cmpProducts.length-1?'disabled':''}>▼</button>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-bold text-gray-800 truncate">\${p.name || p.id}</p>
            <div class="grid grid-cols-2 gap-1.5 mt-2">
              <div>
                <label class="text-xs text-gray-400">Preço</label>
                <input type="text" value="\${p.price||''}" onchange="updateCmpProduct(\${i},'price',this.value)" placeholder="R$ 0,00" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-purple-400">
              </div>
              <div>
                <label class="text-xs text-gray-400">Avaliação</label>
                <input type="number" min="0" max="5" step="0.1" value="\${p.rating||''}" onchange="updateCmpProduct(\${i},'rating',this.value)" placeholder="4.5" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-purple-400">
              </div>
              <div>
                <label class="text-xs text-gray-400">Link Afiliado</label>
                <input type="url" value="\${p.affiliateUrl||''}" onchange="updateCmpProduct(\${i},'affiliateUrl',this.value)" placeholder="https://..." class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-purple-400">
              </div>
              <div>
                <label class="text-xs text-gray-400">Destaque</label>
                <select onchange="updateCmpProduct(\${i},'badge',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-purple-400">
                  <option value="" \${!p.badge?'selected':''}>Nenhum</option>
                  <option value="best" \${p.badge==='best'?'selected':''}>Melhor Escolha</option>
                  <option value="costbenefit" \${p.badge==='costbenefit'?'selected':''}>Custo-Benefício</option>
                </select>
              </div>
            </div>
            <div class="mt-1.5">
              <label class="text-xs text-gray-400">Vantagens (1 por linha)</label>
              <textarea rows="2" onchange="updateCmpProduct(\${i},'pros',this.value)" placeholder="Potente&#10;Silencioso" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-purple-400 resize-none">\${(p.pros||[]).join('\\n')}</textarea>
            </div>
            <div class="mt-1.5">
              <label class="text-xs text-gray-400">Desvantagens (1 por linha)</label>
              <textarea rows="2" onchange="updateCmpProduct(\${i},'cons',this.value)" placeholder="Caro&#10;Pesado" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-purple-400 resize-none">\${(p.cons||[]).join('\\n')}</textarea>
            </div>
          </div>
          <button onclick="removeCmpProduct(\${i})" class="flex-shrink-0 text-red-400 hover:text-red-600 transition-colors text-xs mt-1">
            <i class="fas fa-times-circle text-base"></i>
          </button>
        </div>
      \`).join('')
    }

    function updateCmpProduct(index, field, value) {
      if (!cmpProducts[index]) return
      if (field === 'pros' || field === 'cons') {
        cmpProducts[index][field] = value.split('\\n').map(s => s.trim()).filter(Boolean)
      } else {
        cmpProducts[index][field] = value
      }
    }

    function populateCmpProductSelect() {
      const sel = document.getElementById('cmpAddProductSelect')
      const existing = cmpProducts.map(p => p.id)
      sel.innerHTML = '<option value="">+ Selecionar produto para adicionar...</option>'
      allProducts.forEach(p => {
        if (!existing.includes(p.id)) {
          sel.innerHTML += \`<option value="\${p.id}">\${p.title ? p.title.substring(0,50) : p.id}</option>\`
        }
      })
    }

    function addCmpProduct() {
      const sel = document.getElementById('cmpAddProductSelect')
      const id = sel.value
      if (!id) { showToast('Selecione um produto primeiro', 'info'); return }
      const prod = allProducts.find(p => p.id === id)
      if (!prod) { showToast('Produto não encontrado', 'error'); return }
      cmpProducts.push({
        id: prod.id,
        name: prod.title || prod.name || id,
        image: prod.imageUrl || prod.image || '',
        price: prod.price || '',
        rating: prod.rating || '',
        affiliateUrl: prod.url || prod.affiliateUrl || '',
        badge: '',
        pros: prod.pros || [],
        cons: prod.cons || []
      })
      renderCmpProducts()
      populateCmpProductSelect()
      sel.value = ''
      showToast('Produto adicionado ao comparativo!', 'success')
    }

    function removeCmpProduct(index) {
      cmpProducts.splice(index, 1)
      renderCmpProducts()
      populateCmpProductSelect()
    }

    function moveCmpProduct(index, direction) {
      const newIndex = index + direction
      if (newIndex < 0 || newIndex >= cmpProducts.length) return
      const tmp = cmpProducts[index]
      cmpProducts[index] = cmpProducts[newIndex]
      cmpProducts[newIndex] = tmp
      renderCmpProducts()
    }

    async function generateComparativoAI() {
      if (cmpProducts.length < 2) { showToast('Adicione pelo menos 2 produtos para gerar textos', 'info'); return }
      const btn = document.getElementById('btnGenAI')
      btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> Gerando...'
      btn.disabled = true

      const prodNames = cmpProducts.map(p => p.name || p.id)
      const cat = document.getElementById('cmpCategory')
      const catName = cat.options[cat.selectedIndex]?.text || 'produto'
      const bestProd = cmpProducts.find(p => p.badge === 'best') || cmpProducts[0]
      const cbProd = cmpProducts.find(p => p.badge === 'costbenefit') || cmpProducts[cmpProducts.length > 1 ? 1 : 0]

      // Gerar título
      const titulo = \`\${prodNames[0]} vs \${prodNames.slice(1).join(' vs ')}: Qual é o Melhor \${catName.replace(/[🏠🌡️💨🧹🫧💧⚡🌙🎯🏷️]/g,'')} em 2025?\`
      document.getElementById('cmpTitle').value = titulo

      // Gerar meta descrição SEO
      const metaDesc = \`Descubra a diferença entre \${prodNames.slice(0,2).join(' e ')}. Comparativo completo com preço, qualidade, avaliações e qual vale mais a pena comprar em 2025.\`
      document.getElementById('cmpMetaDesc').value = metaDesc.substring(0, 160)

      // Gerar resumo humanizado
      const ratings = cmpProducts.map(p => p.rating ? \`\${p.name || p.id} com nota \${p.rating}\` : null).filter(Boolean)
      const ratingsText = ratings.length ? \` Em avaliações de usuários, \${ratings.join(', ')}.\` : ''
      const prices = cmpProducts.map(p => p.price ? \`o \${p.name || p.id} custa \${p.price}\` : null).filter(Boolean)
      const pricesText = prices.length ? \` Quando falamos de preço, \${prices.join(' enquanto ')}.\` : ''

      const summaryParts = [
        \`Escolher entre \${prodNames.join(', ')} pode ser difícil sem uma análise aprofundada. Cada modelo tem características próprias que se encaixam melhor em perfis diferentes de usuário.\`,
        pricesText,
        ratingsText,
        \`Neste comparativo, analisamos os principais critérios — preço, desempenho, custo-benefício e experiência do usuário — para ajudar você a tomar a melhor decisão.\`
      ]
      document.getElementById('cmpSummary').value = summaryParts.filter(Boolean).join(' ')

      // Gerar conclusão
      const conclusionParts = []
      if (bestProd) conclusionParts.push(\`Se você busca a melhor performance e está disposto a investir mais, o \${bestProd.name || bestProd.id} é nossa principal recomendação — ele se destaca em qualidade e durabilidade.\`)
      if (cbProd && cbProd.id !== bestProd?.id) conclusionParts.push(\`Para quem quer uma excelente relação qualidade-preço sem gastar demais, o \${cbProd.name || cbProd.id} é a escolha inteligente.\`)
      if (cmpProducts.length > 2) conclusionParts.push(\`As demais opções também atendem bem nichos específicos, como quem prioriza \${catName.toLowerCase()} compacto ou design diferenciado.\`)
      conclusionParts.push(\`No final, a melhor escolha depende do seu orçamento, das suas necessidades diárias e da frequência de uso. Avalie bem antes de decidir!\`)
      document.getElementById('cmpConclusion').value = conclusionParts.join(' ')

      // Gerar FAQ
      const faqItems = [
        \`P: Qual é o melhor \${catName.replace(/[🏠🌡️💨🧹🫧💧⚡🌙🎯🏷️]/g,'').trim()} entre \${prodNames.slice(0,2).join(' e ')}?\nR: Para uso intenso e performance máxima, recomendamos o \${bestProd.name || bestProd.id}. Para custo-benefício, o \${cbProd.name || cbProd.id} é a escolha mais inteligente.\`,
        \`P: Vale a pena pagar mais caro por um \${catName.replace(/[🏠🌡️💨🧹🫧💧⚡🌙🎯🏷️]/g,'').trim()} premium?\nR: Depende da frequência de uso. Para uso diário intenso, o investimento se paga em durabilidade e eficiência. Para uso ocasional, um modelo intermediário já atende muito bem.\`,
        \`P: Qual tem a melhor garantia?\nR: Verifique sempre as condições de garantia diretamente com o fabricante, pois políticas mudam com frequência. Geralmente modelos premium oferecem garantia estendida.\`,
        \`P: Onde comprar com o melhor preço?\nR: Recomendamos verificar os links de afiliados deste comparativo, que direcionam para as melhores ofertas disponíveis no momento.\`
      ]
      document.getElementById('cmpFaq').value = faqItems.join('\\n\\n')

      await new Promise(r => setTimeout(r, 600)) // pequeno delay para efeito de carregamento
      btn.innerHTML = '<i class="fas fa-magic"></i> Gerar Textos Automáticos'
      btn.disabled = false
      showToast('Textos gerados com sucesso!', 'success')
    }

    async function saveComparativo() {
      const title = document.getElementById('cmpTitle').value.trim()
      if (!title) { showToast('Informe o título do comparativo', 'info'); return }
      if (cmpProducts.length < 2) { showToast('Adicione pelo menos 2 produtos', 'info'); return }

      const btn = document.getElementById('btnSaveCmp')
      btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>'
      btn.disabled = true

      const editId = document.getElementById('cmpEditId').value
      const payload = {
        title,
        category: document.getElementById('cmpCategory').value,
        status: document.getElementById('cmpStatus').value,
        summary: document.getElementById('cmpSummary').value,
        conclusion: document.getElementById('cmpConclusion').value,
        faq: document.getElementById('cmpFaq').value,
        metaDesc: document.getElementById('cmpMetaDesc').value,
        notes: document.getElementById('cmpNotes').value,
        products: cmpProducts
      }

      try {
        const url = editId ? '/api/comparativos/' + editId : '/api/comparativos'
        const method = editId ? 'PUT' : 'POST'
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const data = await res.json()
        if (data.success) {
          showToast(editId ? 'Comparativo atualizado!' : 'Comparativo criado!', 'success')
          openNewComparativo()
          await loadComparativos()
        } else {
          showToast(data.error || 'Erro ao salvar', 'error')
        }
      } catch(e) {
        showToast('Erro ao salvar comparativo', 'error')
      }
      btn.innerHTML = '<i class="fas fa-save"></i> Salvar'
      btn.disabled = false
    }

    async function deleteComparativo(id) {
      const _cmpItem = (window._allComparativos || []).find(c => c.id === id)
      const title = _cmpItem ? _cmpItem.title : 'este comparativo'
      if (!confirm(\`Excluir o comparativo "\${title}"? Esta ação não pode ser desfeita.\`)) return
      try {
        const res = await fetch('/api/comparativos/' + id, { method: 'DELETE' })
        const data = await res.json()
        if (data.success) {
          showToast('Comparativo excluído!', 'success')
          await loadComparativos()
        } else {
          showToast('Erro ao excluir', 'error')
        }
      } catch(e) {
        showToast('Erro ao excluir comparativo', 'error')
      }
    }

    // ======= COMPARE OS PREÇOS (Admin) =======
    let pcStores = []

    const PC_STORE_PRESETS = {
      amazon:       { storeType: 'amazon',       name: 'Amazon',        buttonText: 'Ver na Amazon',         shipping: 'Frete Prime disponível' },
      mercadolivre: { storeType: 'mercadolivre', name: 'Mercado Livre', buttonText: 'Ver no Mercado Livre',  shipping: 'Frete Grátis disponível' },
      shopee:       { storeType: 'shopee',       name: 'Shopee',        buttonText: 'Ver na Shopee',         shipping: 'Frete grátis em alguns itens' },
      magalu:       { storeType: 'magalu',       name: 'Magazine Luiza',buttonText: 'Ver na Magalu',         shipping: 'Entrega rápida disponível' },
      americanas:   { storeType: 'americanas',   name: 'Americanas',    buttonText: 'Ver nas Americanas',    shipping: 'Frete especial disponível' }
    }

    async function loadPriceCompareAdmin() {
      const list = document.getElementById('pcList')
      const countEl = document.getElementById('pcCount')
      list.innerHTML = '<div class="text-center py-8 text-gray-400"><span class="spinner"></span><p class="mt-3 text-sm">Carregando...</p></div>'
      try {
        const res = await fetch('/api/pricecompare')
        const data = await res.json()
        countEl.textContent = (data.length || 0) + ' total'
        if (!data.length) {
          list.innerHTML = '<div class="text-center py-16 text-gray-400"><i class="fas fa-tags text-5xl mb-4 opacity-30"></i><p class="text-lg font-medium">Nenhuma comparação cadastrada ainda</p><p class="text-sm mt-1">Use o formulário ao lado para criar a primeira</p></div>'
          return
        }
        list.innerHTML = data.map(pc => \`
          <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 card-admin">
            <div class="flex items-start justify-between gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-bold px-2 py-0.5 rounded-full \${pc.active !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">\${pc.active !== false ? 'Ativo' : 'Inativo'}</span>
                  <span class="text-xs text-gray-400 font-mono">/artigo/\${pc.slug}</span>
                </div>
                <h3 class="font-black text-gray-900 text-base leading-tight truncate">\${pc.productName}</h3>
                <p class="text-xs text-gray-400 mt-1">Atualizado: \${pc.updatedAt ? new Date(pc.updatedAt).toLocaleDateString('pt-BR') : '—'}</p>
              </div>
              <div class="flex flex-col gap-2 flex-shrink-0">
                <button onclick="editPriceCompare('\${pc.id}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5">
                  <i class="fas fa-edit"></i> Editar
                </button>
                <button onclick="deletePriceCompare('\${pc.id}','\${pc.productName.replace(/'/g,'')}')" class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-bold px-3 py-2 rounded-xl transition-all flex items-center gap-1.5">
                  <i class="fas fa-trash"></i> Excluir
                </button>
              </div>
            </div>
          </div>
        \`).join('')
      } catch(e) {
        list.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fas fa-times-circle text-3xl mb-3"></i><p>Erro ao carregar</p></div>'
      }
    }

    function openNewPriceCompare() {
      document.getElementById('pcEditId').value = ''
      document.getElementById('pcFormTitle').textContent = 'Nova Comparação'
      document.getElementById('pcProductName').value = ''
      document.getElementById('pcSlug').value = ''
      document.getElementById('pcActive').value = 'true'
      pcStores = []
      renderPcStores()
    }

    async function editPriceCompare(id) {
      try {
        const res = await fetch('/api/pricecompare/' + id)
        const pc = await res.json()
        document.getElementById('pcEditId').value = pc.id
        document.getElementById('pcFormTitle').textContent = 'Editar Comparação'
        document.getElementById('pcProductName').value = pc.productName || ''
        document.getElementById('pcSlug').value = pc.slug || ''
        document.getElementById('pcActive').value = (pc.active !== false) ? 'true' : 'false'
        pcStores = pc.stores || []
        renderPcStores()
        switchTab('precos')
        showToast('Comparação carregada para edição', 'info')
      } catch(e) { showToast('Erro ao carregar', 'error') }
    }

    function addPcStorePreset(type) {
      const preset = PC_STORE_PRESETS[type]
      if (!preset) return
      pcStores.push({ ...preset, price: '', customUrl: '', logoUrl: '', badge: '', active: true, isBest: false, order: pcStores.length })
      renderPcStores()
      showToast(preset.name + ' adicionado!', 'success')
    }

    function addPcStore() {
      pcStores.push({ storeType: 'custom', name: 'Nova Loja', buttonText: 'Ver oferta', shipping: '', price: '', customUrl: '', logoUrl: '', badge: '', active: true, isBest: false, order: pcStores.length })
      renderPcStores()
    }

    function removePcStore(idx) {
      pcStores.splice(idx, 1)
      renderPcStores()
    }

    function updatePcStore(idx, field, value) {
      if (pcStores[idx]) pcStores[idx][field] = (field === 'isBest' || field === 'active') ? (value === 'true' || value === true) : value
    }

    function movePcStore(idx, dir) {
      const n = idx + dir
      if (n < 0 || n >= pcStores.length) return
      const tmp = pcStores[idx]; pcStores[idx] = pcStores[n]; pcStores[n] = tmp
      renderPcStores()
    }

    function renderPcStores() {
      const container = document.getElementById('pcStoresList')
      if (!pcStores.length) {
        container.innerHTML = '<p class="text-gray-400 text-xs text-center py-2">Use os botões acima para adicionar marketplaces</p>'
        return
      }
      container.innerHTML = pcStores.map((s, i) => \`
        <div class="bg-white border border-gray-200 rounded-xl p-3">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-1.5">
              <button onclick="movePcStore(\${i},-1)" class="w-6 h-5 bg-gray-100 hover:bg-gray-200 rounded text-gray-500 text-xs" \${i===0?'disabled':''}>▲</button>
              <button onclick="movePcStore(\${i},1)" class="w-6 h-5 bg-gray-100 hover:bg-gray-200 rounded text-gray-500 text-xs" \${i===pcStores.length-1?'disabled':''}>▼</button>
              <span class="text-xs font-bold text-gray-700">\${s.name}</span>
            </div>
            <button onclick="removePcStore(\${i})" class="text-red-400 hover:text-red-600 text-xs"><i class="fas fa-times-circle text-base"></i></button>
          </div>
          <div class="grid grid-cols-2 gap-1.5">
            <div>
              <label class="text-xs text-gray-400">Nome da Loja</label>
              <input value="\${s.name}" onchange="updatePcStore(\${i},'name',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div>
              <label class="text-xs text-gray-400">Preço</label>
              <input value="\${s.price||''}" placeholder="R$ 299,90" onchange="updatePcStore(\${i},'price',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div>
              <label class="text-xs text-gray-400">Frete</label>
              <input value="\${s.shipping||''}" placeholder="Frete Grátis" onchange="updatePcStore(\${i},'shipping',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div>
              <label class="text-xs text-gray-400">Texto do Botão</label>
              <input value="\${s.buttonText||'Ver oferta'}" onchange="updatePcStore(\${i},'buttonText',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div class="col-span-2">
              <label class="text-xs text-gray-400">Link Afiliado / Customizado (opcional)</label>
              <input value="\${s.customUrl||''}" placeholder="https://..." onchange="updatePcStore(\${i},'customUrl',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div class="col-span-2">
              <label class="text-xs text-gray-400">URL do Logo (opcional)</label>
              <input value="\${s.logoUrl||''}" placeholder="https://..." onchange="updatePcStore(\${i},'logoUrl',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div>
              <label class="text-xs text-gray-400">Etiqueta / Badge</label>
              <input value="\${s.badge||''}" placeholder="Mais barato!" onchange="updatePcStore(\${i},'badge',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-gray-400">Melhor Oferta?</label>
              <select onchange="updatePcStore(\${i},'isBest',this.value)" class="w-full text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:border-green-400">
                <option value="false" \${!s.isBest?'selected':''}>Não</option>
                <option value="true" \${s.isBest?'selected':''}>Sim ⭐</option>
              </select>
            </div>
          </div>
        </div>
      \`).join('')
    }

    async function savePriceCompare() {
      const productName = document.getElementById('pcProductName').value.trim()
      const slug = document.getElementById('pcSlug').value.trim()
      if (!productName) { showToast('Informe o nome do produto', 'info'); return }
      if (!slug) { showToast('Informe o slug do artigo', 'info'); return }
      if (!pcStores.length) { showToast('Adicione pelo menos uma loja', 'info'); return }

      const btn = document.getElementById('btnSavePc')
      btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>'
      btn.disabled = true

      const editId = document.getElementById('pcEditId').value
      const payload = {
        productName,
        slug,
        active: document.getElementById('pcActive').value === 'true',
        showInArticle: true,
        stores: pcStores
      }

      try {
        const url = editId ? '/api/pricecompare/' + editId : '/api/pricecompare'
        const method = editId ? 'PUT' : 'POST'
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const data = await res.json()
        if (data.success) {
          showToast(editId ? 'Comparação atualizada!' : 'Comparação criada!', 'success')
          openNewPriceCompare()
          await loadPriceCompareAdmin()
        } else {
          showToast(data.error || 'Erro ao salvar', 'error')
        }
      } catch(e) { showToast('Erro ao salvar', 'error') }
      btn.innerHTML = '<i class="fas fa-save"></i> Salvar'
      btn.disabled = false
    }

    async function deletePriceCompare(id, name) {
      if (!confirm('Excluir a comparação "' + name + '"?')) return
      try {
        const res = await fetch('/api/pricecompare/' + id, { method: 'DELETE' })
        const data = await res.json()
        if (data.success) { showToast('Comparação excluída!', 'success'); await loadPriceCompareAdmin() }
        else showToast('Erro ao excluir', 'error')
      } catch(e) { showToast('Erro ao excluir', 'error') }
    }

    // ======= INIT =======
    async function init() {
      try {
        const res = await fetch('/api/categories')
        categories = await res.json()
        const catSelect = document.getElementById('categoryId')
        const filterSelect = document.getElementById('filterCategory')
        const destaqueFilter = document.getElementById('destaqueCatFilter')
        const cmpCatSelect = document.getElementById('cmpCategory')
        categories.forEach(cat => {
          if (catSelect) catSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
          if (filterSelect) filterSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
          if (destaqueFilter) destaqueFilter.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
          if (cmpCatSelect) cmpCatSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
        })
      } catch(e) { console.error('Erro ao carregar categorias:', e) }
      await loadProducts()
      // Ativar modo manutenção ao abrir o painel
      try {
        await fetch('/api/admin/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) })
      } catch(e) { console.log('Manutenção não ativada:', e) }
    }

    init()
  </script>
</body>
</html>`
}

// === HELPER: navbar compartilhada ===
function sharedNavbar(): string {
  return `
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-2">
          <img src="/static/logo.png" alt="TeckHome Store" class="w-10 h-10 rounded-xl object-cover shadow-md">
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span> Store</span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Descubra antes de comprar</span>
          </div>
        </a>
        <a href="/" class="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-indigo-600 transition-colors">
          <i class="fas fa-arrow-left text-xs"></i> Voltar ao início
        </a>
      </div>
    </div>
  </nav>`
}

// === HELPER: footer compartilhado ===
function sharedFooter(): string {
  return `
  <footer class="bg-gray-900 text-white py-8 px-4 mt-16">
    <div class="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-gray-400">
      <div class="flex items-center gap-2">
        <img src="/static/logo.png" alt="TeckHome Store" class="w-8 h-8 rounded-lg object-cover">
        <span class="font-bold text-white">Teck<span class="text-indigo-400">Home</span> Store</span>
      </div>
      <div class="flex flex-wrap justify-center gap-4">
        <a href="/termos-de-uso" class="hover:text-white transition-colors">Termos de Uso</a>
        <a href="/politica-de-privacidade" class="hover:text-white transition-colors">Privacidade</a>
        <a href="/politica-de-cookies" class="hover:text-white transition-colors">Cookies</a>
        <a href="/sobre" class="hover:text-white transition-colors">Sobre Nós</a>
      </div>
      <p>© 2026 TeckHome Store</p>
    </div>
  </footer>`
}

// === PÁGINA DE ARTIGO DO BLOG ===
function articlePage(article: any): string {
  const title = article.title || 'Artigo TeckHome'
  const excerpt = article.excerpt || ''
  const content = article.content || `<p>${excerpt}</p>`
  const image = article.image || 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80'
  const category = article.category || 'Geral'
  const categoryIcon = article.categoryIcon || '📝'
  const readTime = article.readTime || '5 min'
  const keywords = article.keywords || ''
  const productUrl = article.productUrl || ''
  const store = article.store || ''
  const categoryId = article.categoryId || ''
  const categoryUrl = categoryId ? `/categoria/${categoryId}` : '/#categorias'

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>${title} — TeckHome Store</title>
  <meta name="description" content="${excerpt.substring(0, 160)}">
  ${keywords ? `<meta name="keywords" content="${keywords}">` : ''}
  <meta name="robots" content="index, follow">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${excerpt.substring(0, 200)}">
  <meta property="og:image" content="${image}">
  <meta property="og:type" content="article">
  <link rel="canonical" href="https://teckhomestore.com/artigo/${article.slug}">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; box-sizing: border-box; }

    /* Reading progress bar */
    #readingProgress { position:fixed; top:0; left:0; height:3px; width:0%; background:linear-gradient(90deg,#6366f1,#818cf8,#38bdf8); z-index:9999; transition:width 0.1s linear; }

    /* Article body typography */
    .article-body h2 { font-size:1.6rem; font-weight:900; color:#111827; margin:2.5rem 0 0.75rem; padding-left:16px; border-left:4px solid #6366f1; line-height:1.3; }
    .article-body h3 { font-size:1.2rem; font-weight:800; color:#1f2937; margin:1.75rem 0 0.6rem; }
    .article-body p { color:#374151; line-height:1.95; margin-bottom:1.25rem; font-size:1.07rem; }
    .article-body ul, .article-body ol { margin:0.75rem 0 1.25rem 1.75rem; }
    .article-body li { color:#374151; line-height:1.85; margin-bottom:0.5rem; font-size:1.05rem; }
    .article-body ul { list-style:disc; }
    .article-body ol { list-style:decimal; }
    .article-body strong { color:#111827; font-weight:800; }
    .article-body a { color:#6366f1; text-decoration:underline; }

    /* Hero article */
    .hero-article { position:relative; height:480px; overflow:hidden; }
    .hero-article img { width:100%; height:100%; object-fit:cover; }
    .hero-article-overlay { position:absolute; inset:0; background:linear-gradient(to bottom,rgba(0,0,0,0.05) 0%,rgba(0,0,0,0.35) 40%,rgba(0,0,0,0.82) 100%); }

    /* Navbar article */
    .navbar-article { background:rgba(255,255,255,0.97); backdrop-filter:blur(20px); border-bottom:1px solid rgba(99,102,241,0.1); box-shadow:0 1px 20px rgba(99,102,241,0.07); }

    /* Related cards */
    .related-card { transition:all 0.3s cubic-bezier(.4,0,.2,1); }
    .related-card:hover { transform:translateY(-5px); box-shadow:0 20px 48px rgba(99,102,241,0.14); }

    /* Scrollbar */
    ::-webkit-scrollbar { width:6px; }
    ::-webkit-scrollbar-track { background:#f1f1f1; }
    ::-webkit-scrollbar-thumb { background:linear-gradient(180deg,#6366f1,#818cf8); border-radius:6px; }

    /* FA fix */
    i.fas, i.fa, i.far { font-family:'Font Awesome 6 Free' !important; font-weight:900 !important; font-style:normal !important; }
    i.fab { font-family:'Font Awesome 6 Brands' !important; font-weight:400 !important; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- BARRA DE PROGRESSO DE LEITURA -->
  <div id="readingProgress"></div>

  <!-- NAVBAR -->
  <nav class="navbar-article sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <div class="flex items-center gap-3">
          <!-- Botão Voltar visível -->
          <a href="/" title="Voltar à página inicial"
            class="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold px-4 py-2 rounded-xl transition-all shadow-sm hover:shadow-md shrink-0"
            style="text-decoration:none;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            <span class="hidden sm:inline">Voltar</span>
          </a>
          <a href="/" class="flex items-center gap-2.5 group" style="text-decoration:none;">
            <img src="/static/logo.png" alt="TeckHome Store" class="w-9 h-9 rounded-xl object-cover shadow-md group-hover:shadow-indigo-200 transition-shadow">
            <div class="hidden md:block">
              <span class="text-lg font-black text-gray-900 tracking-tight">Teck<span class="text-indigo-600">Home</span> Store</span>
              <span class="text-xs text-gray-400 block leading-none -mt-0.5">Descubra antes de comprar</span>
            </div>
          </a>
        </div>
        <div class="flex items-center gap-4">
          <a href="/#blog" class="text-sm font-semibold text-gray-600 hover:text-indigo-600 transition-colors flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Blog
          </a>
          <a href="${categoryUrl}" class="text-sm font-semibold text-indigo-600 hover:text-indigo-800 transition-colors border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50 flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/></svg>
            ${category}
          </a>
        </div>
      </div>
    </div>
  </nav>

  <!-- HERO DO ARTIGO -->
  <div class="hero-article">
    <img src="${image}" alt="${title}" onerror="this.src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80'">
    <div class="hero-article-overlay"></div>
    <div class="absolute bottom-0 left-0 right-0 p-6 md:p-12">
      <div class="max-w-4xl mx-auto">
        <nav aria-label="Breadcrumb" class="text-sm text-white/70 mb-4 flex items-center gap-2">
          <a href="/" class="hover:text-white transition-colors">Início</a>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
          <a href="/#blog" class="hover:text-white transition-colors">Blog</a>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
          <span class="text-white/90">${category}</span>
        </nav>
        <div class="flex items-center gap-2 mb-4">
          <span class="bg-indigo-600 text-white text-xs font-bold px-3 py-1.5 rounded-full">${category}</span>
          <span class="bg-black/50 backdrop-blur-sm text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${readTime} de leitura
          </span>
        </div>
        <h1 class="text-2xl md:text-4xl lg:text-5xl font-black text-white leading-tight drop-shadow-2xl max-w-3xl">${title}</h1>
      </div>
    </div>
  </div>

  <!-- CONTEÚDO DO ARTIGO -->
  <main id="articleMain" class="max-w-3xl mx-auto px-4 py-12">

    <!-- Autor + Meta -->
    <div class="flex items-center gap-4 mb-8 pb-6 border-b border-gray-100">
      <div class="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-md" style="background:linear-gradient(135deg,#1e1b4b,#3730a3);">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </div>
      <div class="flex-1">
        <p class="font-black text-gray-900 text-sm">Equipe TeckHome</p>
        <p class="text-gray-400 text-xs mt-0.5">Análise editorial independente · TeckHome Store · 2026</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="bg-green-50 text-green-700 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 border border-green-100">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Verificado
        </span>
        <span class="bg-indigo-50 text-indigo-600 text-xs font-bold px-3 py-1.5 rounded-full border border-indigo-100">
          ${readTime}
        </span>
      </div>
    </div>

    <!-- Excerpt destacado -->
    <div class="bg-gradient-to-r from-indigo-50 to-blue-50 border-l-4 border-indigo-500 rounded-r-2xl p-6 mb-10 shadow-sm">
      <p class="text-indigo-900 font-semibold text-lg leading-relaxed">${excerpt}</p>
    </div>

    <!-- Corpo do artigo -->
    <article class="article-body">
      ${content}
    </article>

    <!-- COMPARE OS PREÇOS -->
    <div id="priceCompareSection" class="hidden mt-10"></div>

    <!-- CTA de categoria -->
    <div class="mt-12 rounded-3xl overflow-hidden shadow-2xl" style="background:linear-gradient(135deg,#1e1b4b 0%,#3730a3 50%,#1e3a5f 100%);">
      <div class="p-8 text-center">
        <span class="inline-block text-indigo-300 text-xs font-bold uppercase tracking-widest mb-3">Pronto para comprar?</span>
        <h3 class="text-2xl font-black text-white mb-2">Melhores produtos de ${category}</h3>
        <p class="text-indigo-200 text-sm mb-6">Seleção curada pela Equipe TeckHome com os melhores preços verificados</p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="${categoryUrl}" class="inline-flex items-center justify-center gap-2 bg-white text-indigo-700 font-black px-8 py-4 rounded-2xl hover:bg-indigo-50 transition-all shadow-lg text-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
            Ver produtos de ${category}
          </a>
          ${productUrl ? `
          <a href="${productUrl}" target="_blank" rel="noopener noreferrer sponsored"
            class="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white font-semibold px-6 py-4 rounded-2xl transition-all text-sm border border-white/20">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Ver oferta${store ? ` na ${store}` : ''}
          </a>` : ''}
        </div>
      </div>
    </div>

    <!-- Artigos Relacionados -->
    <div class="mt-12 pt-10 border-t border-gray-100">
      <h3 class="text-xl font-black text-gray-900 mb-6 flex items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        Artigos Relacionados
      </h3>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <a href="/artigo/guia-eletronicos" class="related-card bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 group" style="text-decoration:none;">
          <div class="h-28 overflow-hidden"><img src="https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&q=70" alt="Eletrônicos" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"></div>
          <div class="p-4"><span class="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">Eletrônicos</span><p class="text-sm font-bold text-gray-800 mt-2 leading-snug group-hover:text-indigo-600 transition-colors">Como escolher o melhor smartphone em 2026</p></div>
        </a>
        <a href="/artigo/guia-eletrodomesticos" class="related-card bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 group" style="text-decoration:none;">
          <div class="h-28 overflow-hidden"><img src="https://images.unsplash.com/photo-1585515320310-259814833e62?w=400&q=70" alt="Eletrodomésticos" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"></div>
          <div class="p-4"><span class="text-xs font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">Eletrodomésticos</span><p class="text-sm font-bold text-gray-800 mt-2 leading-snug group-hover:text-indigo-600 transition-colors">Air fryer ou forno elétrico? A verdade</p></div>
        </a>
        <a href="/artigo/guia-refrigeracao" class="related-card bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 group" style="text-decoration:none;">
          <div class="h-28 overflow-hidden"><img src="https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=400&q=70" alt="Refrigeração" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"></div>
          <div class="p-4"><span class="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">Refrigeração</span><p class="text-sm font-bold text-gray-800 mt-2 leading-snug group-hover:text-indigo-600 transition-colors">Ar-condicionado 2026: guia definitivo</p></div>
        </a>
      </div>
    </div>

    <!-- Aviso editorial -->
    <div class="mt-8 p-4 bg-gray-50 border border-gray-200 rounded-2xl text-xs text-gray-500 leading-relaxed flex items-start gap-3">
      <svg class="flex-shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span><strong class="text-gray-600">Aviso de afiliados:</strong> Este artigo pode conter links de afiliados. Caso você realize uma compra através deles, recebemos uma comissão sem custo adicional para você. Isso não influencia nossas análises.</span>
    </div>

    <!-- Navegação inferior -->
    <div class="mt-8 pt-8 border-t border-gray-100 flex items-center justify-between gap-4">
      <a href="/#blog" class="flex items-center gap-2 text-indigo-600 font-bold hover:text-indigo-800 transition-colors text-sm">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Ver todos os artigos
      </a>
      <a href="${categoryUrl}" class="flex items-center gap-2 text-indigo-600 font-bold hover:text-indigo-800 transition-colors text-sm">
        Ver produtos de ${category}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </a>
    </div>

  </main>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white py-10 px-4 mt-12">
    <div class="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6 text-sm text-gray-400">
      <div class="flex items-center gap-3">
        <img src="/static/logo.png" alt="TeckHome Store" class="w-9 h-9 rounded-xl object-cover shadow-lg">
        <div>
          <span class="font-black text-white">Teck<span class="text-indigo-400">Home</span> Store</span>
          <p class="text-gray-500 text-xs mt-0.5">Portal de Reviews</p>
        </div>
      </div>
      <div class="flex flex-wrap justify-center gap-5">
        <a href="/#blog" class="hover:text-white transition-colors">Blog</a>
        <a href="/termos-de-uso" class="hover:text-white transition-colors">Termos</a>
        <a href="/politica-de-privacidade" class="hover:text-white transition-colors">Privacidade</a>
        <a href="/sobre" class="hover:text-white transition-colors">Sobre Nós</a>
      </div>
      <p class="text-gray-500">© 2026 TeckHome Store</p>
    </div>
  </footer>

  <script>
    // Barra de progresso de leitura
    const bar = document.getElementById('readingProgress')
    const main = document.getElementById('articleMain')
    window.addEventListener('scroll', () => {
      const rect = main.getBoundingClientRect()
      const total = main.offsetHeight - window.innerHeight
      const scrolled = Math.max(0, -rect.top)
      const pct = Math.min(100, total > 0 ? (scrolled / total) * 100 : 0)
      bar.style.width = pct + '%'
    }, { passive: true })

    // ===== COMPARE OS PREÇOS =====
    const ARTICLE_SLUG = '${article.slug || ''}'

    // Logos SVG dos marketplaces (inline para não depender de CDN)
    const STORE_LOGOS = {
      amazon: '<svg viewBox="0 0 100 30" width="80" height="24" xmlns="http://www.w3.org/2000/svg"><text x="0" y="22" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="#FF9900" letter-spacing="-0.5">amazon</text><path d="M5 26 Q30 32 55 26 Q45 28 55 26" stroke="#FF9900" stroke-width="2" fill="none" stroke-linecap="round"/><text x="57" y="26" font-family="Arial,sans-serif" font-size="14" fill="#FF9900">.com.br</text></svg>',
      mercadolivre: '<svg viewBox="0 0 120 28" width="100" height="24" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="14" r="12" fill="#FFE600"/><path d="M8 14 L14 8 L20 14 L14 20 Z" fill="#009EE3"/><text x="30" y="19" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#333">Mercado Livre</text></svg>',
      shopee: '<svg viewBox="0 0 80 28" width="65" height="24" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="2" width="76" height="24" rx="4" fill="#EE4D2D"/><text x="8" y="19" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="white">Shopee</text></svg>',
      magalu: '<svg viewBox="0 0 90 28" width="75" height="24" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="2" width="86" height="24" rx="4" fill="#0086FF"/><text x="8" y="19" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="white">Magalu</text></svg>',
      americanas: '<svg viewBox="0 0 120 28" width="100" height="24" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="2" width="116" height="24" rx="4" fill="#D32F2F"/><text x="8" y="19" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="white">Americanas</text></svg>',
      custom: '<svg viewBox="0 0 80 28" width="65" height="24" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="2" width="76" height="24" rx="4" fill="#6366f1"/><text x="8" y="19" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="white">Loja</text></svg>'
    }

    function generateStoreUrl(storeName, productName) {
      const q = encodeURIComponent(productName)
      const qDash = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
      const storeMap = {
        amazon: 'https://www.amazon.com.br/s?k=' + q,
        mercadolivre: 'https://lista.mercadolivre.com.br/' + qDash,
        shopee: 'https://shopee.com.br/search?keyword=' + encodeURIComponent(productName),
        magalu: 'https://www.magazineluiza.com.br/busca/' + qDash + '/',
        americanas: 'https://www.americanas.com.br/busca/' + q
      }
      return storeMap[storeName.toLowerCase()] || null
    }

    function renderPriceCompare(config) {
      if (!config || !config.active || !config.stores || config.stores.length === 0) return

      const section = document.getElementById('priceCompareSection')
      if (!section) return
      section.classList.remove('hidden')

      const bestStore = config.stores.find(s => s.isBest && s.active !== false)
      const activeStores = config.stores.filter(s => s.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0))
      const now = new Date()
      const updateText = config.updatedAt ? new Date(config.updatedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : now.toLocaleDateString('pt-BR')

      section.innerHTML = \`
        <div style="background:white;border-radius:20px;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);" itemscope itemtype="https://schema.org/ItemList">
          <!-- Header -->
          <div style="background:linear-gradient(135deg,#1e1b4b,#3730a3);padding:18px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="background:rgba(255,255,255,0.15);border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              </div>
              <div>
                <p style="color:rgba(199,210,254,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 2px;">Compare os Preços</p>
                <h3 style="color:white;font-size:16px;font-weight:900;margin:0;line-height:1.2;" itemprop="name">\${config.productName}</h3>
              </div>
            </div>
            \${bestStore ? \`<div style="background:rgba(245,158,11,0.2);border:1px solid rgba(245,158,11,0.4);color:#fcd34d;font-size:11px;font-weight:800;padding:5px 12px;border-radius:20px;white-space:nowrap;display:flex;align-items:center;gap:5px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="#fcd34d"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>Melhor oferta: \${bestStore.name}</div>\` : ''}
          </div>

          <!-- Store Cards -->
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
            \${activeStores.map((store, idx) => {
              const logoKey = (store.storeType || 'custom').toLowerCase()
              const logoSvg = STORE_LOGOS[logoKey] || STORE_LOGOS.custom
              const url = store.customUrl || (store.productName ? generateStoreUrl(store.storeType || '', store.productName) : null) || generateStoreUrl(store.storeType || '', config.productName)
              const isBest = store.isBest
              const hasPrice = store.price && store.price.trim()

              return \`
                <div style="border:\${isBest ? '2px solid #6366f1' : '1px solid #f3f4f6'};border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:14px;background:\${isBest ? 'linear-gradient(135deg,#fafafa,#f5f3ff)' : '#fafafa'};position:relative;transition:all 0.2s;" onmouseover="this.style.boxShadow='0 4px 20px rgba(99,102,241,0.12)';this.style.transform='translateY(-1px)'" onmouseout="this.style.boxShadow='none';this.style.transform='none'" itemscope itemtype="https://schema.org/ListItem">
                  \${isBest ? '<div style="position:absolute;top:-11px;left:16px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;font-size:10px;font-weight:800;padding:3px 10px;border-radius:20px;display:flex;align-items:center;gap:4px;white-space:nowrap;"><svg width=\\"9\\" height=\\"9\\" viewBox=\\"0 0 24 24\\" fill=\\"white\\"><path d=\\"M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z\\"/></svg>Melhor Oferta</div>' : ''}
                  <!-- Logo -->
                  <div style="flex-shrink:0;width:90px;display:flex;align-items:center;justify-content:flex-start;">
                    \${store.logoUrl ? \`<img src="\${store.logoUrl}" alt="\${store.name}" style="max-width:80px;max-height:28px;object-fit:contain;">\` : (logoSvg)}
                  </div>
                  <!-- Info -->
                  <div style="flex:1;min-width:0;">
                    <p style="font-size:14px;font-weight:800;color:#1f2937;margin:0 0 2px;" itemprop="name">\${store.name}</p>
                    \${store.shipping ? \`<p style="font-size:12px;color:\${store.shipping.toLowerCase().includes('grátis') ? '#059669' : '#6b7280'};margin:0;font-weight:600;">\${store.shipping}</p>\` : ''}
                    \${store.badge ? \`<span style="display:inline-block;margin-top:4px;background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;">\${store.badge}</span>\` : ''}
                  </div>
                  <!-- Price + Button -->
                  <div style="flex-shrink:0;text-align:right;">
                    \${hasPrice ? \`<p style="font-size:20px;font-weight:900;color:\${isBest ? '#6366f1' : '#059669'};margin:0 0 6px;line-height:1;" itemprop="price">\${store.price}</p>\` : '<p style="font-size:13px;color:#9ca3af;margin:0 0 6px;">Ver preço</p>'}
                    \${url ? \`<a href="\${url}" target="_blank" rel="noopener noreferrer sponsored" style="display:inline-flex;align-items:center;gap:5px;background:\${isBest ? 'linear-gradient(135deg,#6366f1,#4f46e5)' : '#374151'};color:white;font-size:12px;font-weight:800;padding:8px 16px;border-radius:10px;text-decoration:none;transition:all 0.2s;white-space:nowrap;" onmouseover="this.style.filter='brightness(1.1)'" onmouseout="this.style.filter='none'">\${store.buttonText || 'Ver oferta'}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>\` : ''}
                  </div>
                </div>
              \`
            }).join('')}
          </div>

          <!-- Footer -->
          <div style="background:#f9fafb;border-top:1px solid #f3f4f6;padding:10px 22px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <p style="font-size:11px;color:#9ca3af;margin:0;display:flex;align-items:center;gap:5px;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Última atualização: \${updateText}
            </p>
            <p style="font-size:10px;color:#d1d5db;margin:0;">Links de afiliados · Sem custo adicional para você</p>
          </div>
        </div>
      \`
    }

    async function loadPriceCompare() {
      if (!ARTICLE_SLUG) return
      try {
        const res = await fetch('/api/pricecompare')
        const list = await res.json()
        const match = list.find(pc => pc.slug === ARTICLE_SLUG && pc.active !== false)
        if (!match) return
        const detailRes = await fetch('/api/pricecompare/' + match.id)
        const config = await detailRes.json()
        if (config && config.showInArticle !== false) {
          renderPriceCompare(config)
        }
      } catch(e) { console.log('Compare preços não carregado', e) }
    }

    loadPriceCompare()
  </script>

</body>
</html>`
}

// === PÁGINA: TERMOS DE USO ===
// === PÁGINA DE LOGIN DO ADMIN ===
function loginPage(erro?: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>Acesso Restrito — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; box-sizing: border-box; }
    .gradient-bg { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #1e3a5f 100%); }
    .input-field { width:100%; padding: 12px 44px 12px 40px; border: 2px solid #e5e7eb; border-radius: 12px; font-size: 14px; outline: none; transition: all 0.2s; background: #fafafa; }
    .input-field:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.12); background: #fff; }
    .btn-eye { position:absolute; right:12px; top:50%; transform:translateY(-50%); background:none; border:none; cursor:pointer; padding:4px; color:#9ca3af; transition:color 0.2s; }
    .btn-eye:hover { color:#6366f1; }
    .credentials-box { background: linear-gradient(135deg, #f0f9ff, #e0f2fe); border: 1px solid #bae6fd; border-radius: 14px; padding: 14px 16px; margin-bottom: 20px; }
  </style>
</head>
<body class="gradient-bg min-h-screen flex items-center justify-center px-4 py-8">

  <div class="w-full max-w-sm">

    <!-- Logo -->
    <div class="text-center mb-8">
      <img src="/static/logo.png" alt="TeckHome Store" class="w-20 h-20 rounded-2xl object-cover shadow-2xl mx-auto mb-4 border-2 border-white/20">
      <h1 class="text-2xl font-black text-white">Teck<span class="text-indigo-300">Home</span> Store</h1>
      <p class="text-indigo-300 text-sm mt-1">Painel Administrativo</p>
    </div>

    <!-- Card de login -->
    <div class="bg-white rounded-3xl shadow-2xl p-8">

      <div class="flex items-center gap-3 mb-6">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <h2 class="font-black text-gray-900 text-lg">Acesso Restrito</h2>
          <p class="text-gray-400 text-xs">Apenas administradores</p>
        </div>
      </div>

      ${erro ? `
      <div class="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-5 flex items-center gap-2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        ${erro}
      </div>` : ''}



      <form method="POST" action="/admin/login" class="space-y-4">

        <!-- Campo Usuário -->
        <div>
          <label class="text-sm font-semibold text-gray-700 block mb-1.5">Usuário</label>
          <div class="relative">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            <input
              type="text"
              name="username"
              id="username"
              placeholder=""
              autocomplete="off"
              readonly
              onfocus="this.removeAttribute('readonly')"
              required
              class="input-field"
            >
          </div>
        </div>

        <!-- Campo Senha com botão olho -->
        <div>
          <label class="text-sm font-semibold text-gray-700 block mb-1.5">Senha</label>
          <div class="relative">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <input
              type="password"
              name="password"
              id="passwordInput"
              placeholder=""
              autocomplete="off"
              readonly
              onfocus="this.removeAttribute('readonly')"
              required
              class="input-field"
            >
            <!-- Botão olho — mostra/oculta senha -->
            <button type="button" class="btn-eye" id="togglePassword" onclick="togglePass()" title="Mostrar/ocultar senha" aria-label="Mostrar senha">
              <!-- Olho fechado (padrão quando senha está oculta) -->
              <svg id="eyeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </button>
          </div>
          <p class="text-xs text-gray-400 mt-1.5 flex items-center gap-1">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Clique no olho para revelar a senha digitada
          </p>
        </div>

        <button
          type="submit"
          class="w-full bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold py-3.5 rounded-xl transition-all flex items-center justify-center gap-2 mt-2 shadow-lg shadow-indigo-200">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Entrar no Painel
        </button>

      </form>

      <div class="mt-6 pt-5 border-t border-gray-100 text-center">
        <a href="/" class="text-sm text-gray-400 hover:text-indigo-600 transition-colors flex items-center justify-center gap-1.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Voltar ao site
        </a>
      </div>

    </div>

    <p class="text-center text-indigo-300/50 text-xs mt-6">© 2026 TeckHome Store</p>
  </div>

  <script>
    // Toggle mostrar/ocultar senha
    function togglePass() {
      const input = document.getElementById('passwordInput')
      const icon  = document.getElementById('eyeIcon')
      const isHidden = input.type === 'password'
      input.type = isHidden ? 'text' : 'password'

      // Olho aberto (senha visível)
      const eyeOpen = \`<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>\`
      // Olho fechado (senha oculta)
      const eyeClosed = \`<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>\`

      icon.innerHTML = isHidden ? eyeOpen : eyeClosed
      document.getElementById('togglePassword').style.color = isHidden ? '#6366f1' : '#9ca3af'
    }

    // Copia ao clicar nos códigos
    document.querySelectorAll('code[title="Clique para copiar"]').forEach(el => {
      el.addEventListener('click', () => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(el.textContent.trim())
          const orig = el.style.background
          el.style.background = '#dcfce7'
          el.style.borderColor = '#86efac'
          setTimeout(() => { el.style.background = ''; el.style.borderColor = '' }, 1200)
        }
      })
    })
  </script>

</body>
</html>`
}

function termosPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>Termos de Uso — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <main class="max-w-3xl mx-auto px-4 py-14">

    <!-- Cabeçalho -->
    <div class="mb-10">
      <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Legal</span>
      <h1 class="text-4xl font-black text-gray-900 mb-2">Termos de Uso</h1>
      <p class="text-gray-500 text-sm">Última atualização: maio de 2026 · <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
      <div class="w-16 h-1 bg-indigo-600 rounded-full mt-4"></div>
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-8 text-gray-700 leading-relaxed">

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-file-alt text-indigo-500 text-base"></i> 1. Aceitação dos Termos</h2>
        <p>Ao acessar e utilizar o site <strong>TeckHome Store</strong> (teckhomestore.com), você concorda integralmente com estes Termos de Uso. Caso não concorde com qualquer disposição aqui presente, solicitamos que interrompa imediatamente o uso do site.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-info-circle text-indigo-500 text-base"></i> 2. Sobre o Site</h2>
        <p>O TeckHome Store é um portal editorial de conteúdo informativo focado em reviews, comparativos e recomendações de produtos nas categorias de tecnologia, eletrodomésticos, ferramentas, refrigeração, cama e mesa, ventilação e jardim. Todo o conteúdo é produzido pela <strong>Equipe TeckHome</strong> com finalidade exclusivamente informativa.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-link text-indigo-500 text-base"></i> 3. Links de Afiliados</h2>
        <p>Os links de produtos presentes neste site podem ser links de afiliados. Isso significa que podemos receber uma comissão caso você realize uma compra através desses links, <strong>sem custo adicional para você</strong>. Essas parcerias não influenciam nossa avaliação dos produtos.</p>
        <p class="mt-3">Os preços, disponibilidade e condições dos produtos são de responsabilidade exclusiva dos respectivos varejistas (Amazon, Mercado Livre, Shopee, Magazine Luiza, etc.) e podem ser alterados sem aviso prévio.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-ban text-indigo-500 text-base"></i> 4. Uso Proibido</h2>
        <p>É expressamente proibido:</p>
        <ul class="list-disc list-inside mt-3 space-y-1 text-gray-600">
          <li>Reproduzir, copiar ou distribuir o conteúdo sem autorização prévia por escrito</li>
          <li>Utilizar o site para fins ilegais ou fraudulentos</li>
          <li>Tentar acessar áreas restritas do sistema sem autorização</li>
          <li>Publicar conteúdo difamatório, enganoso ou que viole direitos de terceiros</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-pencil-alt text-indigo-500 text-base"></i> 5. Propriedade Intelectual</h2>
        <p>Todo o conteúdo publicado no TeckHome Store — incluindo textos, imagens, logotipos e design — é propriedade do TeckHome Store ou licenciado para uso. É proibida a reprodução total ou parcial sem autorização expressa.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-exclamation-triangle text-indigo-500 text-base"></i> 6. Limitação de Responsabilidade</h2>
        <p>O TeckHome Store não se responsabiliza por decisões de compra tomadas com base em nosso conteúdo, nem por problemas com produtos adquiridos através dos links disponibilizados. As relações de compra e venda são exclusivamente entre o consumidor e o varejista.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-sync text-indigo-500 text-base"></i> 7. Alterações nos Termos</h2>
        <p>Reservamo-nos o direito de alterar estes Termos de Uso a qualquer momento. As alterações entrarão em vigor imediatamente após a publicação no site. O uso continuado do site após as alterações implica na aceitação dos novos termos.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-envelope text-indigo-500 text-base"></i> 8. Contato</h2>
        <p>Para dúvidas sobre estes Termos de Uso, entre em contato:</p>
        <div class="mt-3 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="font-semibold text-gray-800">TeckHome Store</p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-envelope text-indigo-500 mr-2"></i><a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-globe text-indigo-500 mr-2"></i><a href="https://teckhomestore.com" class="text-indigo-600 hover:underline">teckhomestore.com</a></p>
        </div>
      </section>

    </div>
  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === PÁGINA: POLÍTICA DE PRIVACIDADE ===
function privacidadePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>Política de Privacidade — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <main class="max-w-3xl mx-auto px-4 py-14">

    <div class="mb-10">
      <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Legal</span>
      <h1 class="text-4xl font-black text-gray-900 mb-2">Política de Privacidade</h1>
      <p class="text-gray-500 text-sm">Última atualização: maio de 2026 · <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
      <div class="w-16 h-1 bg-indigo-600 rounded-full mt-4"></div>
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-8 text-gray-700 leading-relaxed">

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-shield-alt text-indigo-500 text-base"></i> 1. Compromisso com sua Privacidade</h2>
        <p>O <strong>TeckHome Store</strong> respeita sua privacidade e está comprometido em proteger seus dados pessoais. Esta política explica como coletamos, usamos e protegemos as informações dos nossos visitantes, em conformidade com a <strong>Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018)</strong>.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-database text-indigo-500 text-base"></i> 2. Dados que Coletamos</h2>
        <p>Podemos coletar as seguintes informações:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li><strong>Dados de navegação:</strong> páginas acessadas, tempo de visita, dispositivo e navegador utilizado</li>
          <li><strong>Dados de uso:</strong> buscas realizadas, produtos visualizados e categorias acessadas</li>
          <li><strong>Dados de contato:</strong> nome e e-mail, apenas quando você nos contata voluntariamente</li>
          <li><strong>Cookies e tecnologias similares:</strong> conforme descrito em nossa Política de Cookies</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-cogs text-indigo-500 text-base"></i> 3. Como Usamos seus Dados</h2>
        <p>Utilizamos as informações coletadas para:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Melhorar a experiência de navegação e o conteúdo do site</li>
          <li>Analisar o desempenho das páginas e categorias</li>
          <li>Responder mensagens e solicitações de contato</li>
          <li>Cumprir obrigações legais quando necessário</li>
        </ul>
        <p class="mt-3">Não vendemos, alugamos ou compartilhamos seus dados pessoais com terceiros para fins de marketing.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-share-alt text-indigo-500 text-base"></i> 4. Compartilhamento de Dados</h2>
        <p>Seus dados podem ser compartilhados apenas nas seguintes situações:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Com plataformas de análise (Google Analytics, etc.) de forma anonimizada</li>
          <li>Com autoridades competentes, quando exigido por lei</li>
          <li>Ao clicar em links de afiliados, você será redirecionado para sites de terceiros com suas próprias políticas de privacidade</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-lock text-indigo-500 text-base"></i> 5. Segurança dos Dados</h2>
        <p>Adotamos medidas técnicas e organizacionais adequadas para proteger seus dados contra acesso não autorizado, alteração, divulgação ou destruição. No entanto, nenhum sistema é 100% seguro e não podemos garantir segurança absoluta.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-user-check text-indigo-500 text-base"></i> 6. Seus Direitos (LGPD)</h2>
        <p>Como titular de dados, você tem direito a:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Confirmar a existência de tratamento de seus dados</li>
          <li>Acessar seus dados pessoais</li>
          <li>Solicitar correção de dados incompletos ou incorretos</li>
          <li>Solicitar a exclusão dos seus dados</li>
          <li>Revogar o consentimento a qualquer momento</li>
        </ul>
        <p class="mt-3">Para exercer esses direitos, entre em contato pelo e-mail <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline font-medium">contato@teckhomestore.com</a>.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-external-link-alt text-indigo-500 text-base"></i> 7. Sites de Terceiros</h2>
        <p>Nosso site contém links para lojas parceiras e afiliados. Ao acessar esses sites, você estará sujeito às políticas de privacidade deles. Não nos responsabilizamos pelo tratamento de dados realizado por terceiros.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-envelope text-indigo-500 text-base"></i> 8. Contato do Responsável</h2>
        <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="font-semibold text-gray-800">TeckHome Store — Encarregado de Dados (DPO)</p>
          <p class="text-sm text-gray-600 mt-2"><i class="fas fa-envelope text-indigo-500 mr-2"></i><a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-globe text-indigo-500 mr-2"></i><a href="https://teckhomestore.com" class="text-indigo-600 hover:underline">teckhomestore.com</a></p>
        </div>
      </section>

    </div>
  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === PÁGINA: POLÍTICA DE COOKIES ===
function cookiesPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>Política de Cookies — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <main class="max-w-3xl mx-auto px-4 py-14">

    <div class="mb-10">
      <span class="inline-block bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full mb-3">Legal</span>
      <h1 class="text-4xl font-black text-gray-900 mb-2">Política de Cookies</h1>
      <p class="text-gray-500 text-sm">Última atualização: maio de 2026 · <a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
      <div class="w-16 h-1 bg-indigo-600 rounded-full mt-4"></div>
    </div>

    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-8 text-gray-700 leading-relaxed">

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-cookie-bite text-indigo-500 text-base"></i> 1. O que são Cookies?</h2>
        <p>Cookies são pequenos arquivos de texto armazenados no seu dispositivo quando você visita um site. Eles servem para melhorar sua experiência de navegação, lembrar suas preferências e coletar informações sobre como o site é utilizado.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-list text-indigo-500 text-base"></i> 2. Tipos de Cookies que Utilizamos</h2>

        <div class="space-y-4 mt-3">
          <div class="p-4 bg-green-50 rounded-xl border border-green-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-check-circle text-green-500"></i> Cookies Essenciais</h3>
            <p class="text-sm text-gray-600">Necessários para o funcionamento básico do site. Não podem ser desativados. Incluem cookies de sessão e de segurança.</p>
          </div>
          <div class="p-4 bg-blue-50 rounded-xl border border-blue-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-chart-bar text-blue-500"></i> Cookies de Desempenho / Análise</h3>
            <p class="text-sm text-gray-600">Coletam informações anônimas sobre como os visitantes usam o site (páginas mais acessadas, tempo de visita, etc.). Utilizamos ferramentas como Google Analytics.</p>
          </div>
          <div class="p-4 bg-purple-50 rounded-xl border border-purple-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-sliders-h text-purple-500"></i> Cookies de Funcionalidade</h3>
            <p class="text-sm text-gray-600">Permitem que o site lembre suas preferências (idioma, modo de visualização, etc.) para melhorar sua experiência.</p>
          </div>
          <div class="p-4 bg-orange-50 rounded-xl border border-orange-100">
            <h3 class="font-bold text-gray-800 text-sm flex items-center gap-2 mb-1"><i class="fas fa-ad text-orange-500"></i> Cookies de Parceiros / Afiliados</h3>
            <p class="text-sm text-gray-600">Quando você clica em um link de afiliado, cookies de terceiros podem ser definidos pelos varejistas parceiros (Amazon, Mercado Livre, etc.) para rastrear a origem da compra.</p>
          </div>
        </div>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-tools text-indigo-500 text-base"></i> 3. Como Gerenciar Cookies</h2>
        <p>Você pode controlar e/ou excluir cookies conforme desejar. A maioria dos navegadores permite:</p>
        <ul class="list-disc list-inside mt-3 space-y-2 text-gray-600">
          <li>Visualizar os cookies armazenados e excluí-los individualmente</li>
          <li>Bloquear cookies de terceiros</li>
          <li>Bloquear cookies de sites específicos</li>
          <li>Bloquear todos os cookies</li>
          <li>Excluir todos os cookies ao fechar o navegador</li>
        </ul>
        <p class="mt-3 text-sm text-gray-500">Atenção: desativar cookies pode afetar o funcionamento de algumas funcionalidades do site.</p>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-clock text-indigo-500 text-base"></i> 4. Tempo de Armazenamento</h2>
        <div class="overflow-x-auto mt-3">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="bg-gray-50">
                <th class="text-left p-3 border border-gray-200 font-semibold text-gray-700">Tipo de Cookie</th>
                <th class="text-left p-3 border border-gray-200 font-semibold text-gray-700">Duração</th>
              </tr>
            </thead>
            <tbody>
              <tr><td class="p-3 border border-gray-200">Sessão</td><td class="p-3 border border-gray-200">Até fechar o navegador</td></tr>
              <tr class="bg-gray-50"><td class="p-3 border border-gray-200">Preferências</td><td class="p-3 border border-gray-200">Até 1 ano</td></tr>
              <tr><td class="p-3 border border-gray-200">Análise (Analytics)</td><td class="p-3 border border-gray-200">Até 2 anos</td></tr>
              <tr class="bg-gray-50"><td class="p-3 border border-gray-200">Afiliados</td><td class="p-3 border border-gray-200">Conforme política do parceiro</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 class="text-xl font-bold text-gray-900 mb-3 flex items-center gap-2"><i class="fas fa-envelope text-indigo-500 text-base"></i> 5. Contato</h2>
        <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="font-semibold text-gray-800">TeckHome Store</p>
          <p class="text-sm text-gray-600 mt-2"><i class="fas fa-envelope text-indigo-500 mr-2"></i><a href="mailto:contato@teckhomestore.com" class="text-indigo-600 hover:underline">contato@teckhomestore.com</a></p>
          <p class="text-sm text-gray-600 mt-1"><i class="fas fa-globe text-indigo-500 mr-2"></i><a href="https://teckhomestore.com" class="text-indigo-600 hover:underline">teckhomestore.com</a></p>
        </div>
      </section>

    </div>
  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === PÁGINA: SOBRE NÓS ===
function sobrePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/static/logo.png">
  <title>Sobre Nós — TeckHome Store</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .gradient-hero { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #1e3a5f 70%, #0f172a 100%); }
    @keyframes gradientMove { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${sharedNavbar()}

  <!-- Hero -->
  <section class="gradient-hero text-white py-16 px-4 text-center">
    <div class="max-w-3xl mx-auto">
      <img src="/static/logo.png" alt="TeckHome Store" class="w-24 h-24 rounded-2xl object-cover shadow-2xl mx-auto mb-6 border-2 border-white/20">
      <h1 class="text-4xl md:text-5xl font-black mb-3">Sobre o TeckHome Store</h1>
      <p class="text-indigo-300 text-lg">Descubra antes de comprar</p>
    </div>
  </section>

  <main class="max-w-3xl mx-auto px-4 py-14 space-y-8">

    <!-- Missão -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-4 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-bullseye text-indigo-600"></i></div>
        Nossa Missão
      </h2>
      <p class="text-gray-600 leading-relaxed">
        O <strong>TeckHome Store</strong> nasceu com um objetivo claro: <strong>ajudar consumidores brasileiros a fazer escolhas de compra mais inteligentes</strong>. Em um mercado com milhares de produtos e opções, nossa missão é organizar, analisar e recomendar os melhores itens de tecnologia, eletrodomésticos e utilidades para o lar.
      </p>
      <p class="text-gray-600 leading-relaxed mt-4">
        Acreditamos que uma boa decisão de compra começa com informação de qualidade. Por isso, a Equipe TeckHome produz conteúdo editorial imparcial, baseado em análises técnicas, avaliações reais de usuários e comparativos de mercado.
      </p>
    </div>

    <!-- O que fazemos -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-6 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-star text-indigo-600"></i></div>
        O que Fazemos
      </h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100">
          <i class="fas fa-search text-indigo-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">Reviews de Produtos</h3>
          <p class="text-sm text-gray-500">Análises detalhadas com pontos positivos, negativos e para quem o produto é indicado.</p>
        </div>
        <div class="p-4 bg-blue-50 rounded-xl border border-blue-100">
          <i class="fas fa-balance-scale text-blue-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">Comparativos</h3>
          <p class="text-sm text-gray-500">Comparamos produtos similares para ajudar você a escolher o melhor custo-benefício.</p>
        </div>
        <div class="p-4 bg-sky-50 rounded-xl border border-sky-100">
          <i class="fas fa-tags text-sky-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">Melhores Preços</h3>
          <p class="text-sm text-gray-500">Links diretos para as maiores lojas do Brasil com os melhores preços disponíveis.</p>
        </div>
        <div class="p-4 bg-emerald-50 rounded-xl border border-emerald-100">
          <i class="fas fa-th-large text-emerald-600 mb-2"></i>
          <h3 class="font-bold text-gray-800 mb-1">7 Categorias</h3>
          <p class="text-sm text-gray-500">Eletrônicos, Eletrodomésticos, Ferramentas, Refrigeração, Cama e Mesa, Ventilação e Jardim.</p>
        </div>
      </div>
    </div>

    <!-- Equipe -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-4 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-users text-indigo-600"></i></div>
        Equipe TeckHome
      </h2>
      <div class="flex items-start gap-5">
        <div class="w-16 h-16 rounded-2xl flex-shrink-0 flex items-center justify-center shadow-md" style="background: linear-gradient(135deg, #1e1b4b 0%, #3730a3 50%, #1e3a5f 100%);">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        </div>
        <div>
          <p class="text-gray-600 leading-relaxed">
            A <strong>Equipe TeckHome</strong> reúne conteúdos, análises e recomendações de produtos voltados para tecnologia, casa e utilidades do dia a dia. Nosso objetivo é ajudar consumidores a fazer escolhas mais inteligentes através de reviews organizados, comparativos e conteúdos informativos.
          </p>
          <p class="text-gray-600 leading-relaxed mt-3">
            Todo o conteúdo publicado é produzido com foco informativo, baseado em análises de mercado, avaliações públicas e características técnicas dos produtos, sempre com total transparência sobre nosso modelo de monetização via links de afiliados.
          </p>
        </div>
      </div>
    </div>

    <!-- Contato -->
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
      <h2 class="text-2xl font-black text-gray-900 mb-6 flex items-center gap-3">
        <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center"><i class="fas fa-envelope text-indigo-600"></i></div>
        Entre em Contato
      </h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <a href="mailto:contato@teckhomestore.com" class="flex items-center gap-4 p-5 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-400 hover:shadow-md transition-all group">
          <div class="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-700 transition-colors">
            <i class="fas fa-envelope text-white"></i>
          </div>
          <div>
            <div class="font-bold text-gray-800 text-sm">E-mail</div>
            <div class="text-indigo-600 text-sm font-medium mt-0.5">contato@teckhomestore.com</div>
          </div>
        </a>
        <a href="https://teckhomestore.com" target="_blank" rel="noopener noreferrer" class="flex items-center gap-4 p-5 bg-indigo-50 rounded-2xl border border-indigo-100 hover:border-indigo-400 hover:shadow-md transition-all group">
          <div class="w-12 h-12 bg-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-700 transition-colors">
            <i class="fas fa-globe text-white"></i>
          </div>
          <div>
            <div class="font-bold text-gray-800 text-sm">Site</div>
            <div class="text-indigo-600 text-sm font-medium mt-0.5">teckhomestore.com</div>
          </div>
        </a>
      </div>
      <p class="text-gray-500 text-sm mt-5 leading-relaxed">
        Tem sugestões de produtos para analisarmos, quer fazer uma parceria ou tem alguma dúvida? Entre em contato! Respondemos em até 48 horas úteis.
      </p>
    </div>

  </main>

  ${sharedFooter()}
</body>
</html>`
}

// === SITEMAP.XML ===
app.get('/sitemap.xml', (c) => {
  const base = 'https://teckhomestore.com'
  const now = new Date().toISOString().split('T')[0]

  const staticPages = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/sobre', priority: '0.6', changefreq: 'monthly' },
    { loc: '/termos-de-uso', priority: '0.4', changefreq: 'yearly' },
    { loc: '/politica-de-privacidade', priority: '0.4', changefreq: 'yearly' },
  ]

  const categories = [
    'eletronicos', 'eletrodomesticos', 'ferramentas',
    'refrigeracao', 'cama-mesa', 'ventilacao', 'jardim'
  ]

  const articles = [
    'guia-eletronicos',
    'guia-eletrodomesticos',
    'guia-refrigeracao',
    'guia-ferramentas',
  ]

  const urls = [
    ...staticPages.map(p => `
  <url>
    <loc>${base}${p.loc}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`),
    ...categories.map(cat => `
  <url>
    <loc>${base}/categoria/${cat}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`),
    ...articles.map(slug => `
  <url>
    <loc>${base}/artigo/${slug}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>`),
  ].join('')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
          http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
${urls}
</urlset>`

  return c.text(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' })
})

export default app
