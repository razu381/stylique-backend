require("dotenv").config({ path: ".env" });

const express = require("express");
const app = express();
let cors = require("cors");
const port = 3000;

app.use(
  cors({
    origin: ["https://styliqueecommerce.netlify.app", "http://localhost:5173"],
  })
);
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.jd0pjh8.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {});

async function run() {
  try {
    // // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    // // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );

    const database = client.db("stylique");
    const productCollection = database.collection("products");
    const reviewCollection = database.collection("reviews");
    const orderCollection = database.collection("orders");
    const customerCollection = database.collection("customers");

    //avoid duplicate orders
    await orderCollection.createIndex({ idempotencyKey: 1 }, { unique: true });

    app.get("/products/category/:category", async (req, res) => {
      try {
        let category = req.params.category;
        let filter = { category };
        let result = await productCollection.find(filter).toArray();
        res.send(result);
      } catch (err) {
        console.log("Error fetching products");
        res
          .status(500)
          .send({ error: "Failed to fetch products", details: err.message });
      }
    });

    //all products
    app.get("/products", async (req, res) => {
      try {
        const raw = {
          category: req.query.category,
          minPrice: req.query.minPrice,
          maxPrice: req.query.maxPrice,
          rating: req.query.rating,
          search: req.query.search,
        };
        console.log("raw ", raw);
        const parsed = {
          category: raw.category,
          minPrice: raw.minPrice ? parseFloat(raw.minPrice) : undefined,
          maxPrice: raw.maxPrice ? parseFloat(raw.maxPrice) : undefined,
          rating: raw.rating ? parseFloat(raw.rating) : undefined,
          search: raw.search ? raw.search.trim() : undefined,
        };
        console.log("parsed", parsed);
        const filter = buildProductFilter(parsed);
        const result = await productCollection.find(filter).toArray();
        res.send(result);
      } catch (err) {
        console.error("Error filtering products:", err);
        res
          .status(500)
          .send({ error: "Unable to fetch products", details: err.message });
      }
    });

    //make filters
    function buildProductFilter({
      category,
      minPrice,
      maxPrice,
      rating,
      search,
    }) {
      const filter = {};

      if (category) {
        filter.category = category;
      }

      if (minPrice != null || maxPrice != null) {
        filter.price = {};
        if (minPrice != null) filter.price.$gte = minPrice;
        if (maxPrice != null) filter.price.$lte = maxPrice;
      }

      if (rating != null) {
        filter.rating = { $gte: rating };
      }

      if (search) {
        filter.name = { $regex: search, $options: "i" };
      }
      console.log("filter", filter);
      return filter;
    }

    //filter range
    app.get("/products/filter-stats", async (req, res) => {
      try {
        const [stats] = await productCollection
          .aggregate([
            {
              $group: {
                _id: null,
                minPrice: { $min: "$price" },
                maxPrice: { $max: "$price" },
                minRating: { $min: "$rating" },
                maxRating: { $max: "$rating" },
              },
            },
          ])
          .toArray();

        res.json({
          price: { min: stats.minPrice, max: stats.maxPrice },
          rating: { min: stats.minRating, max: stats.maxRating },
        });
      } catch (err) {
        console.error("Error computing filter stats:", err);
        res.status(500).send({
          error: "Failed to compute filter statistics",
          details: err.message,
        });
      }
    });

    app.get("/categories", async (req, res) => {
      try {
        let result = await productCollection.distinct("category");
        res.send(result);
      } catch (err) {
        console.log("Error fetching categories");
        res
          .status(500)
          .send({ error: "Failed to fetch categories", details: err.message });
      }
    });

    //get single product
    app.get("/products/:id", async (req, res) => {
      try {
        let id = req.params.id;

        let filter = { _id: new ObjectId(id) };
        let result = await productCollection.findOne(filter);
        res.send(result);
      } catch (err) {
        console.log("Error fetching product");
        res
          .status(500)
          .send({ error: "Failed to fetch the product", details: err.message });
      }
    });

    // -------------- Reviews starts from here --------------
    app.get("/reviews/:productId", async (req, res) => {
      try {
        let productId = req.params.productId;
        console.log("productId it's hitted", productId);
        let filter = { productId };
        let result = await reviewCollection.find(filter).toArray();

        console.log(result);
        res.send(result);
      } catch (err) {
        console.log("Error fetching reviews");
        res
          .status(500)
          .send({ error: "Failed to fetch reviews", details: err.message });
      }
    });

    //post product  reviews
    app.post("/reviews", async (req, res) => {
      try {
        let review = req.body;
        let result = await reviewCollection.insertOne(review);
        res.send(result);
      } catch (err) {
        console.log("Error posting reviews");
        res
          .status(500)
          .send({ error: "Failed to post review", details: err.message });
      }
    });

    // -------------- order ------------------
    app.post("/checkout", async (req, res) => {
      try {
        let orderInfo = req.body;

        //check for each items stock
        let inStock = true;
        for (let item of orderInfo.cartItems) {
          let { productId, count, name } = item;
          let productData = await productCollection.findOne({
            _id: new ObjectId(productId),
          });
          if (!productData || productData.stock < count) {
            return res.status(409).send({
              error: "Stock not available",
              productId,
              name,
            });
          }
        }

        if (inStock) {
          let result = await orderCollection.insertOne(orderInfo);

          res.send(result);
        }
      } catch (err) {
        if (err.code === 11000) {
          return res.status(409).send({
            error: "Duplicate order",
          });
        }
        console.log("Error posting order");
        res
          .status(500)
          .send({ error: "Failed to post order", details: err.message });
      }
    });

    //get order for specific user
    app.get("/checkout/:email", async (req, res) => {
      try {
        let email = req.params.email;
        let filter = { email };
        let result = await orderCollection.find(filter).toArray();

        res.send(result);
      } catch (err) {
        console.log("Error fetching orders");
        res
          .status(500)
          .send({ error: "Failed to fetch orders", details: err.message });
      }
    });

    // ----------- User data -----------
    app.put("/customers", async (req, res) => {
      try {
        let data = req.body;
        let filter = { email: data.email };
        let options = { upsert: true };
        let updateDoc = {
          $setOnInsert: data,
        };

        let result = await customerCollection.updateOne(
          filter,
          updateDoc,
          options
        );
        res.send(result);
      } catch (err) {
        console.log("Error posting reviews");
        res
          .status(500)
          .send({ error: "Failed to post review", details: err.message });
      }
    });

    //get customers
    app.get("/customers/:email", async (req, res) => {
      try {
        let email = req.params.email;
        let filter = { email };
        let result = await customerCollection.findOne(filter);

        res.send(result);
      } catch (err) {
        console.log("Error fetching customer data");
        res.status(500).send({
          error: "Failed to fetch cutomer data",
          details: err.message,
        });
      }
    });
  } finally {
    // Ensures that the client will close when you finish/error
    //await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
