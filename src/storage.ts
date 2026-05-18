import type { Product } from './types'

// In-memory store for local development (KV não disponível localmente sem binding real)
const memoryStore: Map<string, string> = new Map()

export async function getProducts(kv: KVNamespace | null, categoryId: string): Promise<Product[]> {
  const key = `products:${categoryId}`
  let data: string | null = null

  if (kv) {
    data = await kv.get(key)
  } else {
    data = memoryStore.get(key) || null
  }

  if (!data) return []
  try {
    return JSON.parse(data) as Product[]
  } catch {
    return []
  }
}

export async function getAllProducts(kv: KVNamespace | null): Promise<Product[]> {
  const categories = ['eletronicos', 'eletrodomesticos', 'ferramentas', 'refrigeracao', 'cama-mesa', 'ventilacao', 'jardim']
  const all: Product[] = []

  for (const cat of categories) {
    const products = await getProducts(kv, cat)
    all.push(...products)
  }

  return all
}

export async function saveProduct(kv: KVNamespace | null, product: Product): Promise<void> {
  const products = await getProducts(kv, product.categoryId)
  const existing = products.findIndex(p => p.id === product.id)
  
  if (existing >= 0) {
    products[existing] = product
  } else {
    products.unshift(product)
  }

  const key = `products:${product.categoryId}`
  const value = JSON.stringify(products)

  if (kv) {
    await kv.put(key, value)
  } else {
    memoryStore.set(key, value)
  }
}

export async function deleteProduct(kv: KVNamespace | null, categoryId: string, productId: string): Promise<boolean> {
  const products = await getProducts(kv, categoryId)
  const filtered = products.filter(p => p.id !== productId)
  
  if (filtered.length === products.length) return false

  const key = `products:${categoryId}`
  const value = JSON.stringify(filtered)

  if (kv) {
    await kv.put(key, value)
  } else {
    memoryStore.set(key, value)
  }

  return true
}

export async function toggleFeatured(kv: KVNamespace | null, categoryId: string, productId: string): Promise<Product | null> {
  const products = await getProducts(kv, categoryId)
  const product = products.find(p => p.id === productId)
  
  if (!product) return null
  
  product.featured = !product.featured
  
  const key = `products:${categoryId}`
  const value = JSON.stringify(products)

  if (kv) {
    await kv.put(key, value)
  } else {
    memoryStore.set(key, value)
  }

  return product
}
