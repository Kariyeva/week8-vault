import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "node:fs";
import { SimpleVault } from "../target/types/simple_vault";

describe("simple_vault — задание 8", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultState: PublicKey;
  let vaultTokenAccount: PublicKey;
  let shareMint: PublicKey;

  const transactions: Record<string, string> = {};

  const cardPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultState.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  async function chainTime(): Promise<number> {
    const clock = await connection.getAccountInfo(
      SYSVAR_CLOCK_PUBKEY,
      "confirmed"
    );
    if (!clock) throw new Error("Не удалось прочитать часы сети");
    return Number(clock.data.readBigInt64LE(32));
  }

  function createCard(user: Keypair) {
    return program.methods
      .createUserCard()
      .accountsStrict({
        vaultState,
        userCard: cardPda(user.publicKey),
        user: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  function pause(value: boolean, signer = admin) {
    return program.methods
      .setPaused(value)
      .accountsStrict({
        vaultState,
        admin: signer.publicKey,
      })
      .signers([signer])
      .rpc();
  }

  function closeCard(owner: Keypair, cardOwner = owner.publicKey) {
    return program.methods
      .closeUserCard()
      .accountsStrict({
        vaultState,
        userCard: cardPda(cardOwner),
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();
  }

  async function expectCode(
    action: () => Promise<unknown>,
    expected: string
  ) {
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }

    assert.exists(caught, `Ожидалась ошибка ${expected}`);
    const error = caught as {
      error?: { errorCode?: { code?: string } };
    };
    assert.equal(error.error?.errorCode?.code, expected);
  }

  before(async () => {
    const funding = new Transaction();
    for (const user of [userA, userB]) {
      funding.add(SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user.publicKey,
        lamports: 10_000_000,
      }));
    }
    await provider.sendAndConfirm(funding);

    tokenMint = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      6,
      undefined,
      { commitment: "confirmed" }
    );

    [vaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("1. Создаёт vault и проверяет полномочия PDA", async () => {
    transactions.initialize = await program.methods
      .initializeVault()
      .accountsStrict({
        vaultState,
        vaultTokenAccount,
        shareMint,
        tokenMint,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultState);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMint.toBase58());
    assert.equal(
      vault.vaultTokenAccount.toBase58(),
      vaultTokenAccount.toBase58()
    );
    assert.isFalse(vault.paused);

    const tokenAccount = await getAccount(
      connection, vaultTokenAccount, "confirmed"
    );
    assert.equal(tokenAccount.owner.toBase58(), vaultState.toBase58());
    assert.equal(tokenAccount.mint.toBase58(), tokenMint.toBase58());

    const shares = await getMint(connection, shareMint, "confirmed");
    assert.equal(shares.mintAuthority?.toBase58(), vaultState.toBase58());
    assert.equal(shares.decimals, 6);
    assert.equal(shares.supply.toString(), "0");
  });

  it("2. Создаёт две разные карточки и сохраняет время сети", async () => {
    const beforeTime = await chainTime();

    for (const [label, user] of [["A", userA], ["B", userB]] as const) {
      transactions[`create${label}`] = await createCard(user);
      const card = await program.account.userCard.fetch(
        cardPda(user.publicKey)
      );
      const afterTime = await chainTime();

      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultState.toBase58());
      assert.isAbove(card.createdAt.toNumber(), 0);
      assert.isAtLeast(card.createdAt.toNumber(), beforeTime);
      assert.isAtMost(card.createdAt.toNumber(), afterTime);
    }

    assert.notEqual(
      cardPda(userA.publicKey).toBase58(),
      cardPda(userB.publicKey).toBase58()
    );
  });

  it("3. Отклоняет повторное создание карточки", async () => {
    let caught: unknown;
    try {
      await createCard(userA);
    } catch (error) {
      caught = error;
    }

    assert.exists(caught, "Повторное создание должно завершиться ошибкой");
    const error = caught as { logs?: string[]; message?: string };
    const details = [
      ...(error.logs ?? []),
      error.message ?? "",
    ].join("\n");
    assert.match(details, /already in use/i);

    const card = await program.account.userCard.fetch(
      cardPda(userA.publicKey)
    );
    assert.equal(card.owner.toBase58(), userA.publicKey.toBase58());
  });

  it("4. Администратор включает паузу", async () => {
    transactions.pause = await pause(true);
    const vault = await program.account.vaultState.fetch(vaultState);
    assert.isTrue(vault.paused);
  });

  it("5. Посторонний пользователь не может снять паузу", async () => {
    await expectCode(() => pause(false, userB), "Unauthorized");
    const vault = await program.account.vaultState.fetch(vaultState);
    assert.isTrue(vault.paused);
  });

  it("6. Посторонний пользователь не может закрыть чужую карточку", async () => {
    await expectCode(
      () => closeCard(userB, userA.publicKey),
      "Unauthorized"
    );
    const card = await program.account.userCard.fetch(
      cardPda(userA.publicKey)
    );
    assert.equal(card.owner.toBase58(), userA.publicKey.toBase58());
  });

  it("7. Владелец закрывает карточку и получает её SOL", async () => {
    const address = cardPda(userA.publicKey);
    const account = await connection.getAccountInfo(address, "confirmed");
    assert.exists(account);

    const beforeBalance = await connection.getBalance(
      userA.publicKey, "confirmed"
    );
    transactions.close = await closeCard(userA);
    const afterBalance = await connection.getBalance(
      userA.publicKey, "confirmed"
    );

    assert.isNull(await connection.getAccountInfo(address, "confirmed"));
    // Комиссию платит provider (admin), поэтому возврат равен rent.
    assert.equal(afterBalance - beforeBalance, account!.lamports);
  });

  it("8. Во время паузы новая карточка не создаётся", async () => {
    await expectCode(() => createCard(userA), "VaultPaused");
    assert.isNull(
      await connection.getAccountInfo(cardPda(userA.publicKey), "confirmed")
    );
  });

  it("9. После снятия паузы карточку можно создать снова", async () => {
    transactions.unpause = await pause(false);
    transactions.recreate = await createCard(userA);

    const vault = await program.account.vaultState.fetch(vaultState);
    const card = await program.account.userCard.fetch(
      cardPda(userA.publicKey)
    );
    assert.isFalse(vault.paused);
    assert.equal(card.owner.toBase58(), userA.publicKey.toBase58());
    assert.isAbove(card.createdAt.toNumber(), 0);

    const addresses = {
      program: program.programId.toBase58(),
      admin: admin.publicKey.toBase58(),
      tokenMint: tokenMint.toBase58(),
      vaultState: vaultState.toBase58(),
      vaultTokenAccount: vaultTokenAccount.toBase58(),
      shareMint: shareMint.toBase58(),
      userA: userA.publicKey.toBase58(),
      userB: userB.publicKey.toBase58(),
      cardA: cardPda(userA.publicKey).toBase58(),
      cardB: cardPda(userB.publicKey).toBase58(),
    };

    fs.mkdirSync("receipts", { recursive: true });
    fs.writeFileSync(
      "receipts/devnet-tests.json",
      JSON.stringify({
        network: "devnet",
        checkedAt: new Date().toISOString(),
        testsPassed: 9,
        addresses,
        transactions,
      }, null, 2)
    );

    console.log("\nАдреса для отчёта:");
    console.log(JSON.stringify(addresses, null, 2));
    console.log("Результаты сохранены в receipts/devnet-tests.json");
  });
});
